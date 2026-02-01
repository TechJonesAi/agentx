import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError, retryWithBackoff } from '../../src/resilience.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker('test', {
      failureThreshold: 3,
      cooldownMs: 1000,
      successThreshold: 2,
    });
  });

  describe('closed state', () => {
    it('starts in closed state', () => {
      expect(cb.getState()).toBe('closed');
    });

    it('executes functions normally', async () => {
      const result = await cb.execute(() => Promise.resolve(42));
      expect(result).toBe(42);
    });

    it('passes through errors without opening', async () => {
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
      expect(cb.getState()).toBe('closed');
      expect(cb.getStats().failureCount).toBe(1);
    });

    it('opens after reaching failure threshold', async () => {
      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      }
      expect(cb.getState()).toBe('open');
    });

    it('resets failure count on success', async () => {
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      await cb.execute(() => Promise.resolve('ok'));
      expect(cb.getStats().failureCount).toBe(0);
    });
  });

  describe('open state', () => {
    beforeEach(async () => {
      // Force into open state
      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      }
    });

    it('throws CircuitOpenError immediately', async () => {
      try {
        await cb.execute(() => Promise.resolve('should not run'));
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(CircuitOpenError);
        expect((error as CircuitOpenError).remainingCooldownMs).toBeGreaterThan(0);
      }
    });

    it('transitions to half-open after cooldown', async () => {
      // Use a short cooldown
      const fastCb = new CircuitBreaker('fast', {
        failureThreshold: 1,
        cooldownMs: 50,
        successThreshold: 1,
      });

      await expect(fastCb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      expect(fastCb.getState()).toBe('open');

      // Wait for cooldown
      await new Promise((r) => setTimeout(r, 100));

      await fastCb.execute(() => Promise.resolve('ok'));
      expect(fastCb.getState()).toBe('closed');
    });
  });

  describe('half-open state', () => {
    it('closes after success threshold is met', async () => {
      const fastCb = new CircuitBreaker('fast', {
        failureThreshold: 1,
        cooldownMs: 50,
        successThreshold: 2,
      });

      // Open it
      await expect(fastCb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      expect(fastCb.getState()).toBe('open');

      // Wait for cooldown
      await new Promise((r) => setTimeout(r, 100));

      // First success -> half-open
      await fastCb.execute(() => Promise.resolve('ok'));
      expect(fastCb.getState()).toBe('half-open');

      // Second success -> closed
      await fastCb.execute(() => Promise.resolve('ok'));
      expect(fastCb.getState()).toBe('closed');
    });

    it('reopens on failure in half-open', async () => {
      const fastCb = new CircuitBreaker('fast', {
        failureThreshold: 1,
        cooldownMs: 50,
        successThreshold: 2,
      });

      // Open it
      await expect(fastCb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 100));

      // First success -> half-open
      await fastCb.execute(() => Promise.resolve('ok'));
      expect(fastCb.getState()).toBe('half-open');

      // Failure -> back to open
      await expect(fastCb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      expect(fastCb.getState()).toBe('open');
    });
  });

  describe('state change callback', () => {
    it('fires onStateChange when transitioning', async () => {
      const stateChanges: Array<{ from: string; to: string }> = [];
      const tracked = new CircuitBreaker('tracked', {
        failureThreshold: 2,
        cooldownMs: 50,
        successThreshold: 1,
        onStateChange: (from, to) => stateChanges.push({ from, to }),
      });

      await expect(tracked.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      await expect(tracked.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();

      expect(stateChanges).toContainEqual({ from: 'closed', to: 'open' });
    });
  });

  describe('reset', () => {
    it('returns to closed state', async () => {
      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      }
      expect(cb.getState()).toBe('open');

      cb.reset();
      expect(cb.getState()).toBe('closed');
      expect(cb.getStats().failureCount).toBe(0);
    });
  });

  describe('getRemainingCooldown', () => {
    it('returns 0 when closed', () => {
      expect(cb.getRemainingCooldown()).toBe(0);
    });

    it('returns positive value when open', async () => {
      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      }
      expect(cb.getRemainingCooldown()).toBeGreaterThan(0);
    });
  });
});

describe('retryWithBackoff', () => {
  it('succeeds on first try', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries on retryable error', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('ok');

    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stops retrying after maxRetries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    await expect(retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 }))
      .rejects.toThrow('ECONNRESET');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Invalid API key'));

    await expect(retryWithBackoff(fn, {
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 50,
      retryableErrors: ['ECONNRESET'],
    })).rejects.toThrow('Invalid API key');

    expect(fn).toHaveBeenCalledOnce();
  });

  it('calls onRetry callback', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('ok');

    await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, onRetry });
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry.mock.calls[0]![1]).toBe(1); // attempt number
  });
});
