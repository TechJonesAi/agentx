import type { Message } from '../types.js';
import { createLogger } from '../logger.js';
import { estimateMessageTokens } from '../context-manager.js';

const log = createLogger('sessions:compaction');

export type SummarizeFn = (messages: Message[]) => Promise<string>;
export type FlushMemoryFn = (sessionId: string) => Promise<void>;

export interface CompactionConfig {
  /** Trigger compaction when context usage exceeds this fraction (default: 0.8) */
  threshold: number;
  /** Run a silent memory flush before compaction (default: true) */
  autoFlushMemory: boolean;
}

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  threshold: 0.8,
  autoFlushMemory: true,
};

export class CompactionManager {
  private config: CompactionConfig;
  private summarize: SummarizeFn | null = null;
  private flushMemory: FlushMemoryFn | null = null;

  constructor(config?: Partial<CompactionConfig>) {
    this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config };
  }

  setSummarizer(fn: SummarizeFn): void {
    this.summarize = fn;
  }

  setMemoryFlusher(fn: FlushMemoryFn): void {
    this.flushMemory = fn;
  }

  /**
   * Check if compaction is needed and perform it.
   * Returns the compacted messages or null if no compaction was needed.
   */
  async checkAndCompact(
    sessionId: string,
    messages: Message[],
    maxTokens: number,
  ): Promise<{ compacted: boolean; messages: Message[]; summary?: string }> {
    const currentTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    const ratio = currentTokens / maxTokens;

    if (ratio <= this.config.threshold) {
      return { compacted: false, messages };
    }

    log.info({
      sessionId,
      currentTokens,
      maxTokens,
      ratio: Math.round(ratio * 100),
    }, 'Compaction threshold exceeded, compacting');

    // Step 1: Flush durable notes to disk
    if (this.config.autoFlushMemory && this.flushMemory) {
      try {
        await this.flushMemory(sessionId);
        log.info({ sessionId }, 'Memory flushed before compaction');
      } catch (error) {
        log.error({ sessionId, error: error instanceof Error ? error.message : String(error) }, 'Memory flush failed');
      }
    }

    // Step 2: Generate summary of older messages
    const keepRecent = 20;
    const recentMessages = messages.slice(-keepRecent);
    const olderMessages = messages.slice(0, -keepRecent);

    if (olderMessages.length === 0 || !this.summarize) {
      return { compacted: false, messages };
    }

    let summary: string;
    try {
      summary = await this.summarize(olderMessages);
    } catch (error) {
      log.error({ sessionId, error: error instanceof Error ? error.message : String(error) }, 'Compaction summary failed');
      return { compacted: false, messages };
    }

    // Step 3: Replace old messages with summary
    const compactedMessages: Message[] = [
      {
        role: 'system',
        content: `[Compacted — ${olderMessages.length} messages summarized]\n${summary}`,
        timestamp: olderMessages[0]?.timestamp ?? Date.now(),
      },
      ...recentMessages,
    ];

    log.info({
      sessionId,
      originalCount: messages.length,
      compactedCount: compactedMessages.length,
      summarizedMessages: olderMessages.length,
    }, 'Session compacted');

    return { compacted: true, messages: compactedMessages, summary };
  }

  /**
   * Manual compaction with optional custom instructions for the summary.
   */
  async manualCompact(
    sessionId: string,
    messages: Message[],
    maxTokens: number,
    instructions?: string,
  ): Promise<{ compacted: boolean; messages: Message[]; summary?: string }> {
    if (messages.length < 5 || !this.summarize) {
      return { compacted: false, messages };
    }

    // Flush memory first
    if (this.config.autoFlushMemory && this.flushMemory) {
      try {
        await this.flushMemory(sessionId);
      } catch {
        // Best-effort flush
      }
    }

    const keepRecent = 10;
    const recentMessages = messages.slice(-keepRecent);
    const olderMessages = messages.slice(0, -keepRecent);

    if (olderMessages.length === 0) {
      return { compacted: false, messages };
    }

    // Add custom instructions to the messages being summarized
    const toSummarize = instructions
      ? [...olderMessages, { role: 'system' as const, content: `Summarization instructions: ${instructions}`, timestamp: Date.now() }]
      : olderMessages;

    const summary = await this.summarize(toSummarize);

    const compactedMessages: Message[] = [
      {
        role: 'system',
        content: `[Manual compaction — ${olderMessages.length} messages summarized]\n${summary}`,
        timestamp: olderMessages[0]?.timestamp ?? Date.now(),
      },
      ...recentMessages,
    ];

    log.info({ sessionId, originalCount: messages.length, compactedCount: compactedMessages.length }, 'Manual compaction completed');

    return { compacted: true, messages: compactedMessages, summary };
  }

  updateConfig(config: Partial<CompactionConfig>): void {
    Object.assign(this.config, config);
  }
}
