import type { Message, LLMProvider } from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('context-manager');

// ─── Token Estimation ──────────────────────────────────────────────────────

/**
 * Approximate token count using the 4-chars-per-token heuristic.
 * Accurate enough for context window management without requiring tiktoken.
 */
function estimateTokens(text: string): number {
  // ~4 chars per token for English text, ~3.5 for code-heavy content
  return Math.ceil(text.length / 3.8);
}

function estimateMessageTokens(msg: Message): number {
  let tokens = estimateTokens(msg.content);
  // Role/metadata overhead: ~4 tokens per message
  tokens += 4;
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      tokens += estimateTokens(tc.name);
      tokens += estimateTokens(JSON.stringify(tc.arguments));
      tokens += 4; // tool call overhead
    }
  }
  if (msg.toolCallId) {
    tokens += estimateTokens(msg.toolCallId) + 2;
  }
  return tokens;
}

// ─── Provider Context Limits ────────────────────────────────────────────────

const DEFAULT_CONTEXT_LIMITS: Record<string, number> = {
  anthropic: 200_000,
  openai: 128_000,
  ollama: 8_000, // conservative default, varies by model
};

export interface ContextManagerConfig {
  /** Max context window tokens for the provider */
  maxContextTokens: number;
  /** Trigger summarization when this fraction of context is used (default 0.8) */
  summarizationThreshold: number;
  /** Number of recent messages to always keep unsummarized */
  keepRecentMessages: number;
  /** Max tokens reserved for the response */
  reservedOutputTokens: number;
  /** Max tokens for the system prompt */
  systemPromptTokens: number;
}

const DEFAULT_CONFIG: ContextManagerConfig = {
  maxContextTokens: 200_000,
  summarizationThreshold: 0.8,
  keepRecentMessages: 20,
  reservedOutputTokens: 4096,
  systemPromptTokens: 500,
};

export interface ContextWindowResult {
  messages: Message[];
  totalTokens: number;
  wasTruncated: boolean;
  summaryAdded: boolean;
}

type SummarizeFn = (messages: Message[]) => Promise<string>;

// ─── Context Manager ────────────────────────────────────────────────────────

export class ContextManager {
  private config: ContextManagerConfig;
  private summarize: SummarizeFn | null = null;
  private summaryCache = new Map<string, string>(); // sessionId -> latest summary

  constructor(providerName?: string, config?: Partial<ContextManagerConfig>) {
    const providerLimit = DEFAULT_CONTEXT_LIMITS[providerName ?? 'anthropic'] ?? 200_000;
    this.config = {
      ...DEFAULT_CONFIG,
      maxContextTokens: providerLimit,
      ...config,
    };
  }

  setSummarizer(fn: SummarizeFn): void {
    this.summarize = fn;
  }

  /**
   * Get the available token budget for messages (after reserving output + system).
   */
  getMessageBudget(): number {
    return this.config.maxContextTokens
      - this.config.reservedOutputTokens
      - this.config.systemPromptTokens;
  }

  /**
   * Estimate total tokens for a message list.
   */
  estimateTokenCount(messages: Message[]): number {
    return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  }

  /**
   * Check if messages exceed the summarization threshold.
   */
  needsSummarization(messages: Message[]): boolean {
    const budget = this.getMessageBudget();
    const used = this.estimateTokenCount(messages);
    return used > budget * this.config.summarizationThreshold;
  }

  /**
   * Prepare messages for the LLM, summarizing older messages if context is too large.
   * Full history stays in SQLite; only the truncated window goes to the LLM.
   */
  async prepareContext(
    sessionId: string,
    allMessages: Message[],
  ): Promise<ContextWindowResult> {
    const budget = this.getMessageBudget();
    const totalTokens = this.estimateTokenCount(allMessages);

    // If within budget, send everything
    if (totalTokens <= budget) {
      return {
        messages: allMessages,
        totalTokens,
        wasTruncated: false,
        summaryAdded: false,
      };
    }

    log.info({
      sessionId,
      totalTokens,
      budget,
      messageCount: allMessages.length,
    }, 'Context exceeds budget, truncating');

    // Split: keep recent N messages, summarize the rest
    const keepCount = Math.min(this.config.keepRecentMessages, allMessages.length);
    const recentMessages = allMessages.slice(-keepCount);
    const olderMessages = allMessages.slice(0, -keepCount);

    // Generate or retrieve summary for older messages
    let summary = this.summaryCache.get(sessionId);
    if (!summary && olderMessages.length > 0 && this.summarize) {
      try {
        summary = await this.summarize(olderMessages);
        this.summaryCache.set(sessionId, summary);
        log.info({
          sessionId,
          summarizedMessages: olderMessages.length,
          summaryLength: summary.length,
        }, 'Conversation summary generated');
      } catch (error) {
        log.error({ sessionId, error }, 'Failed to generate summary');
      }
    }

    const result: Message[] = [];

    // Prepend summary as a system-context message
    if (summary) {
      result.push({
        role: 'system',
        content: `[Conversation Summary - ${olderMessages.length} earlier messages]\n${summary}`,
        timestamp: olderMessages[0]?.timestamp ?? Date.now(),
      });
    }

    result.push(...recentMessages);

    // If still over budget, progressively drop oldest from recent
    let resultTokens = this.estimateTokenCount(result);
    while (resultTokens > budget && result.length > 2) {
      // Don't drop the summary (index 0) or the last message
      result.splice(summary ? 1 : 0, 1);
      resultTokens = this.estimateTokenCount(result);
    }

    return {
      messages: result,
      totalTokens: resultTokens,
      wasTruncated: true,
      summaryAdded: !!summary,
    };
  }

  /**
   * Invalidate the cached summary for a session (e.g., after it's been fully summarized).
   */
  invalidateSummary(sessionId: string): void {
    this.summaryCache.delete(sessionId);
  }

  /**
   * Update config at runtime (e.g., when switching providers).
   */
  updateConfig(updates: Partial<ContextManagerConfig>): void {
    Object.assign(this.config, updates);
  }

  /**
   * Set context limit based on provider name.
   */
  setProviderLimit(providerName: string): void {
    const limit = DEFAULT_CONTEXT_LIMITS[providerName];
    if (limit) {
      this.config.maxContextTokens = limit;
      log.info({ provider: providerName, maxTokens: limit }, 'Context limit updated');
    }
  }

  getConfig(): ContextManagerConfig {
    return { ...this.config };
  }
}

export { estimateTokens, estimateMessageTokens };
