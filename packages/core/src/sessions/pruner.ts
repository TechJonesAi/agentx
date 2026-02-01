import type { Message } from '../types.js';
import { createLogger } from '../logger.js';
import { estimateMessageTokens } from '../context-manager.js';

const log = createLogger('sessions:pruner');

export interface PruningOptions {
  /** Maximum age for tool results in minutes */
  maxAge?: number;
  /** Keep the N most recent tool results regardless of age */
  keepLastN?: number;
  /** Maximum total tokens for tool result content */
  maxToolResultTokens?: number;
}

export class SessionPruner {
  /**
   * Prune old tool results from a message list for LLM context.
   * Does NOT modify the original array or rewrite transcript history.
   * Returns a new array with pruned tool results replaced by summaries.
   */
  pruneToolResults(messages: Message[], options: PruningOptions): Message[] {
    const now = Date.now();
    const maxAgeMs = (options.maxAge ?? 30) * 60 * 1000;
    const keepLastN = options.keepLastN ?? 5;

    // Identify all tool result messages
    const toolResultIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') {
        toolResultIndices.push(i);
      }
    }

    if (toolResultIndices.length === 0) {
      return [...messages];
    }

    // Always keep the last N tool results
    const protectedIndices = new Set(toolResultIndices.slice(-keepLastN));

    // Build the pruned message list
    const result: Message[] = [];
    let prunedCount = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'tool' && !protectedIndices.has(i)) {
        const age = now - msg.timestamp;

        if (age > maxAgeMs) {
          // Replace with a compact summary
          result.push({
            role: 'tool',
            content: '[Tool result pruned — older than threshold]',
            toolCallId: msg.toolCallId,
            timestamp: msg.timestamp,
          });
          prunedCount++;
          continue;
        }
      }

      result.push(msg);
    }

    // If maxToolResultTokens is set, enforce it
    if (options.maxToolResultTokens) {
      this.enforceTokenLimit(result, options.maxToolResultTokens);
    }

    if (prunedCount > 0) {
      log.info({ prunedCount }, 'Pruned old tool results from context');
    }

    return result;
  }

  /**
   * Enforce a maximum total token budget for tool results.
   * Prunes from oldest to newest.
   */
  private enforceTokenLimit(messages: Message[], maxTokens: number): void {
    // Find all tool results in order
    const toolMsgs: Array<{ index: number; tokens: number }> = [];
    let totalToolTokens = 0;

    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool' && messages[i].content !== '[Tool result pruned — older than threshold]') {
        const tokens = estimateMessageTokens(messages[i]);
        toolMsgs.push({ index: i, tokens });
        totalToolTokens += tokens;
      }
    }

    // Prune from oldest until under budget
    let idx = 0;
    while (totalToolTokens > maxTokens && idx < toolMsgs.length) {
      const item = toolMsgs[idx];
      messages[item.index] = {
        ...messages[item.index],
        content: '[Tool result pruned — token budget exceeded]',
      };
      totalToolTokens -= item.tokens;
      idx++;
    }
  }

  /**
   * Estimate how many tokens would be saved by pruning.
   */
  estimatePruningSavings(messages: Message[], options: PruningOptions): number {
    const original = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    const pruned = this.pruneToolResults(messages, options);
    const prunedTokens = pruned.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    return original - prunedTokens;
  }
}
