import { EventEmitter } from 'eventemitter3';
import { createLogger } from './logger.js';

const log = createLogger('rate-limiter');

// ─── Token Bucket Rate Limiter ──────────────────────────────────────────────

export interface RateLimiterConfig {
  /** Max requests allowed in the window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Max tokens per minute (for LLM APIs with token-based limits) */
  maxTokensPerMinute?: number;
}

export interface RateLimiterEvents {
  limited: (waitMs: number) => void;
  resumed: () => void;
}

interface QueuedRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  tokens: number;
}

/** Provider-specific default limits */
const PROVIDER_LIMITS: Record<string, RateLimiterConfig> = {
  anthropic: {
    maxRequests: 50,      // 50 RPM for most tiers
    windowMs: 60_000,
    maxTokensPerMinute: 80_000,
  },
  openai: {
    maxRequests: 60,      // varies by tier
    windowMs: 60_000,
    maxTokensPerMinute: 150_000,
  },
  ollama: {
    maxRequests: 1000,    // local, effectively unlimited
    windowMs: 60_000,
  },
};

export class RateLimiter extends EventEmitter<RateLimiterEvents> {
  private config: RateLimiterConfig;
  private requestTimestamps: number[] = [];
  private tokenUsage: Array<{ timestamp: number; tokens: number }> = [];
  private queue: QueuedRequest[] = [];
  private draining = false;

  constructor(providerName?: string, config?: Partial<RateLimiterConfig>) {
    super();
    const defaults = PROVIDER_LIMITS[providerName ?? 'anthropic'] ?? PROVIDER_LIMITS['anthropic']!;
    this.config = { ...defaults, ...config };
  }

  /**
   * Wait until a request is allowed, then proceed.
   * Call this before every LLM API call.
   */
  async acquire(estimatedTokens = 0): Promise<void> {
    // Check if we can proceed immediately
    if (this.canProceed(estimatedTokens)) {
      this.recordRequest(estimatedTokens);
      return;
    }

    // Queue the request
    const waitMs = this.getWaitTime(estimatedTokens);
    log.info({ waitMs, queueSize: this.queue.length }, 'Rate limited, queueing request');
    this.emit('limited', waitMs);

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject, tokens: estimatedTokens });
      this.scheduleDrain();
    });
  }

  /**
   * Record actual token usage after a response (for token-based limiting).
   */
  recordTokenUsage(tokens: number): void {
    this.tokenUsage.push({ timestamp: Date.now(), tokens });
    this.cleanOldEntries();
  }

  private canProceed(estimatedTokens: number): boolean {
    this.cleanOldEntries();

    // Request count check
    if (this.requestTimestamps.length >= this.config.maxRequests) {
      return false;
    }

    // Token count check
    if (this.config.maxTokensPerMinute && estimatedTokens > 0) {
      const tokensUsed = this.getTokensUsedInWindow();
      if (tokensUsed + estimatedTokens > this.config.maxTokensPerMinute) {
        return false;
      }
    }

    return true;
  }

  private getWaitTime(estimatedTokens: number): number {
    this.cleanOldEntries();

    let waitMs = 0;

    // Wait for request slot
    if (this.requestTimestamps.length >= this.config.maxRequests) {
      const oldest = this.requestTimestamps[0]!;
      waitMs = Math.max(waitMs, oldest + this.config.windowMs - Date.now() + 100);
    }

    // Wait for token budget
    if (this.config.maxTokensPerMinute && estimatedTokens > 0) {
      const tokensUsed = this.getTokensUsedInWindow();
      if (tokensUsed + estimatedTokens > this.config.maxTokensPerMinute) {
        // Find when enough token budget frees up
        const sorted = [...this.tokenUsage].sort((a, b) => a.timestamp - b.timestamp);
        let freed = 0;
        for (const entry of sorted) {
          freed += entry.tokens;
          if (tokensUsed - freed + estimatedTokens <= this.config.maxTokensPerMinute) {
            waitMs = Math.max(waitMs, entry.timestamp + 60_000 - Date.now() + 100);
            break;
          }
        }
      }
    }

    return Math.max(waitMs, 0);
  }

  private getTokensUsedInWindow(): number {
    const cutoff = Date.now() - 60_000; // always per-minute for tokens
    return this.tokenUsage
      .filter((e) => e.timestamp >= cutoff)
      .reduce((sum, e) => sum + e.tokens, 0);
  }

  private recordRequest(tokens: number): void {
    this.requestTimestamps.push(Date.now());
    if (tokens > 0) {
      this.tokenUsage.push({ timestamp: Date.now(), tokens });
    }
  }

  private cleanOldEntries(): void {
    const requestCutoff = Date.now() - this.config.windowMs;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0]! < requestCutoff) {
      this.requestTimestamps.shift();
    }

    const tokenCutoff = Date.now() - 60_000;
    while (this.tokenUsage.length > 0 && this.tokenUsage[0]!.timestamp < tokenCutoff) {
      this.tokenUsage.shift();
    }
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;

    const drain = () => {
      if (this.queue.length === 0) {
        this.draining = false;
        this.emit('resumed');
        return;
      }

      const next = this.queue[0]!;
      if (this.canProceed(next.tokens)) {
        this.queue.shift();
        this.recordRequest(next.tokens);
        next.resolve();
        // Immediately try the next one
        setImmediate(drain);
      } else {
        const waitMs = this.getWaitTime(next.tokens);
        setTimeout(drain, Math.max(waitMs, 100));
      }
    };

    setImmediate(drain);
  }

  getStats(): {
    pendingRequests: number;
    requestsInWindow: number;
    tokensInWindow: number;
    config: RateLimiterConfig;
  } {
    this.cleanOldEntries();
    return {
      pendingRequests: this.queue.length,
      requestsInWindow: this.requestTimestamps.length,
      tokensInWindow: this.getTokensUsedInWindow(),
      config: { ...this.config },
    };
  }

  /** Update limits at runtime */
  updateConfig(updates: Partial<RateLimiterConfig>): void {
    Object.assign(this.config, updates);
  }

  /** Clear all state */
  reset(): void {
    this.requestTimestamps = [];
    this.tokenUsage = [];
    for (const req of this.queue) {
      req.reject(new Error('Rate limiter reset'));
    }
    this.queue = [];
    this.draining = false;
  }
}

export { PROVIDER_LIMITS };
