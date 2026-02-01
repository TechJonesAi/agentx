import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter, PROVIDER_LIMITS } from '../../src/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.reset();
  });

  describe('constructor', () => {
    it('uses Anthropic defaults', () => {
      limiter = new RateLimiter('anthropic');
      const stats = limiter.getStats();
      expect(stats.config.maxRequests).toBe(50);
      expect(stats.config.windowMs).toBe(60_000);
    });

    it('uses OpenAI defaults', () => {
      limiter = new RateLimiter('openai');
      expect(limiter.getStats().config.maxRequests).toBe(60);
    });

    it('uses Ollama defaults', () => {
      limiter = new RateLimiter('ollama');
      expect(limiter.getStats().config.maxRequests).toBe(1000);
    });

    it('accepts custom config', () => {
      limiter = new RateLimiter('anthropic', { maxRequests: 10, windowMs: 5000 });
      expect(limiter.getStats().config.maxRequests).toBe(10);
      expect(limiter.getStats().config.windowMs).toBe(5000);
    });
  });

  describe('acquire', () => {
    it('allows requests within limit', async () => {
      limiter = new RateLimiter('anthropic', { maxRequests: 5, windowMs: 60_000 });
      await limiter.acquire();
      await limiter.acquire();
      await limiter.acquire();
      const stats = limiter.getStats();
      expect(stats.requestsInWindow).toBe(3);
    });

    it('tracks pending requests when limit reached', async () => {
      limiter = new RateLimiter('anthropic', { maxRequests: 2, windowMs: 100 });

      await limiter.acquire();
      await limiter.acquire();

      // Third request should queue
      const promise = limiter.acquire();
      const stats = limiter.getStats();
      expect(stats.pendingRequests).toBe(1);

      // Wait for window to expire so queued request can proceed
      await promise;
    });

    it('emits limited event when queueing', async () => {
      limiter = new RateLimiter('anthropic', { maxRequests: 1, windowMs: 200 });

      const limitedSpy = vi.fn();
      limiter.on('limited', limitedSpy);

      await limiter.acquire();
      const p = limiter.acquire(); // should be queued

      expect(limitedSpy).toHaveBeenCalledOnce();
      expect(limitedSpy.mock.calls[0]![0]).toBeGreaterThan(0);

      await p;
    });
  });

  describe('recordTokenUsage', () => {
    it('tracks token usage', () => {
      limiter = new RateLimiter('anthropic', { maxRequests: 100, windowMs: 60_000, maxTokensPerMinute: 10_000 });
      limiter.recordTokenUsage(5000);
      expect(limiter.getStats().tokensInWindow).toBe(5000);
    });
  });

  describe('reset', () => {
    it('clears all state', async () => {
      limiter = new RateLimiter('anthropic', { maxRequests: 10, windowMs: 60_000 });
      await limiter.acquire();
      await limiter.acquire();
      limiter.recordTokenUsage(1000);

      limiter.reset();

      const stats = limiter.getStats();
      expect(stats.requestsInWindow).toBe(0);
      expect(stats.tokensInWindow).toBe(0);
      expect(stats.pendingRequests).toBe(0);
    });

    it('rejects queued requests on reset', async () => {
      limiter = new RateLimiter('anthropic', { maxRequests: 1, windowMs: 60_000 });
      await limiter.acquire();

      const promise = limiter.acquire();
      limiter.reset();

      await expect(promise).rejects.toThrow('Rate limiter reset');
    });
  });

  describe('updateConfig', () => {
    it('updates limits at runtime', () => {
      limiter = new RateLimiter('anthropic');
      limiter.updateConfig({ maxRequests: 100 });
      expect(limiter.getStats().config.maxRequests).toBe(100);
    });
  });

  describe('PROVIDER_LIMITS', () => {
    it('has defaults for all providers', () => {
      expect(PROVIDER_LIMITS['anthropic']).toBeDefined();
      expect(PROVIDER_LIMITS['openai']).toBeDefined();
      expect(PROVIDER_LIMITS['ollama']).toBeDefined();
    });
  });
});
