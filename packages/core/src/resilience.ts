import { createLogger } from './logger.js';

const log = createLogger('resilience');

// ─── Retry with Exponential Backoff ─────────────────────────────────────────

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Only retry if error message matches one of these substrings */
  retryableErrors?: string[];
  /** Called before each retry */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  retryableErrors: [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'socket hang up',
    'fetch failed',
    'rate limit',
    'Rate limit',
    '429',
    '500',
    '502',
    '503',
    '529',
    'overloaded',
    'timeout',
    'Timeout',
  ],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: Error, retryableErrors?: string[]): boolean {
  if (!retryableErrors || retryableErrors.length === 0) return true;
  const msg = error.message ?? String(error);
  return retryableErrors.some((re) => msg.includes(re));
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  const opts = { ...DEFAULT_RETRY, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt >= opts.maxRetries) break;
      if (!isRetryable(lastError, opts.retryableErrors)) break;

      // Exponential backoff with jitter
      const baseDelay = opts.baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * opts.baseDelayMs;
      const delay = Math.min(baseDelay + jitter, opts.maxDelayMs);

      log.warn({
        attempt: attempt + 1,
        maxRetries: opts.maxRetries,
        delayMs: Math.round(delay),
        error: lastError.message,
      }, 'Retrying after error');

      opts.onRetry?.(lastError, attempt + 1, delay);
      await sleep(delay);
    }
  }

  throw lastError!;
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Time in ms to wait before trying again (half-open) */
  cooldownMs: number;
  /** Number of successes in half-open to close the circuit */
  successThreshold: number;
  /** Called when state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

const DEFAULT_CIRCUIT: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
  successThreshold: 2,
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private config: CircuitBreakerConfig;
  readonly name: string;

  constructor(name: string, config?: Partial<CircuitBreakerConfig>) {
    this.name = name;
    this.config = { ...DEFAULT_CIRCUIT, ...config };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      // Check if cooldown has elapsed
      if (Date.now() - this.lastFailureTime >= this.config.cooldownMs) {
        this.transition('half-open');
      } else {
        throw new CircuitOpenError(
          `Circuit breaker '${this.name}' is open. Service unavailable.`,
          this.getRemainingCooldown(),
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.transition('closed');
      }
    }
    if (this.state === 'closed') {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.transition('open');
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.transition('open');
    }
  }

  private transition(newState: CircuitState): void {
    if (this.state === newState) return;

    const oldState = this.state;
    this.state = newState;

    if (newState === 'closed') {
      this.failureCount = 0;
      this.successCount = 0;
    } else if (newState === 'half-open') {
      this.successCount = 0;
    }

    log.info({
      breaker: this.name,
      from: oldState,
      to: newState,
    }, 'Circuit breaker state change');

    this.config.onStateChange?.(oldState, newState);
  }

  getState(): CircuitState {
    return this.state;
  }

  getRemainingCooldown(): number {
    if (this.state !== 'open') return 0;
    return Math.max(0, this.config.cooldownMs - (Date.now() - this.lastFailureTime));
  }

  getStats(): { state: CircuitState; failureCount: number; successCount: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
    };
  }

  reset(): void {
    this.transition('closed');
  }
}

export class CircuitOpenError extends Error {
  readonly remainingCooldownMs: number;

  constructor(message: string, remainingMs: number) {
    super(message);
    this.name = 'CircuitOpenError';
    this.remainingCooldownMs = remainingMs;
  }
}
