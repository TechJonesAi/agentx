import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextManager } from '../../src/context-manager.js';
import { CircuitBreaker, retryWithBackoff } from '../../src/resilience.js';
import { RateLimiter } from '../../src/rate-limiter.js';
import type { Message, LLMResponse } from '../../src/types.js';

/**
 * Integration tests that verify how the agent subsystems work together.
 * These don't instantiate a full Agent (which needs a real config + DB)
 * but test the integration of context management, resilience, and rate limiting.
 */

function makeMessage(content: string, role: 'user' | 'assistant' = 'user'): Message {
  return { role, content, timestamp: Date.now() };
}

describe('Agent chat flow integration', () => {
  describe('context manager + summarization', () => {
    it('summarizes long conversations and keeps recent messages', async () => {
      const cm = new ContextManager('ollama', {
        maxContextTokens: 500,
        reservedOutputTokens: 50,
        systemPromptTokens: 50,
        keepRecentMessages: 3,
      });

      const summarizer = vi.fn().mockResolvedValue('User asked about weather. Assistant provided forecasts.');
      cm.setSummarizer(summarizer);

      // Generate 20 messages (way over the 500-token budget)
      const messages: Message[] = [];
      for (let i = 0; i < 20; i++) {
        messages.push(makeMessage(`Message number ${i} with some padding text to use tokens: ${'x'.repeat(100)}`, i % 2 === 0 ? 'user' : 'assistant'));
      }

      const result = await cm.prepareContext('session-1', messages);

      expect(result.wasTruncated).toBe(true);
      expect(result.summaryAdded).toBe(true);
      // Summary message should be first
      expect(result.messages[0]!.role).toBe('system');
      expect(result.messages[0]!.content).toContain('Conversation Summary');
      // Recent messages should be preserved at the end
      expect(result.messages[result.messages.length - 1]!.content).toContain('Message number 19');
    });
  });

  describe('circuit breaker + retry integration', () => {
    it('retries through circuit breaker until it opens', async () => {
      const cb = new CircuitBreaker('test-llm', {
        failureThreshold: 3,
        cooldownMs: 5000,
        successThreshold: 1,
      });

      let callCount = 0;
      const failingFn = () => {
        callCount++;
        return cb.execute(() => Promise.reject(new Error('503 overloaded')));
      };

      await expect(retryWithBackoff(failingFn, {
        maxRetries: 5,
        baseDelayMs: 10,
        maxDelayMs: 50,
      })).rejects.toThrow();

      // Circuit breaker should be open after 3 failures
      expect(cb.getState()).toBe('open');
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it('succeeds after transient failures', async () => {
      const cb = new CircuitBreaker('test-llm', {
        failureThreshold: 5,
        cooldownMs: 5000,
        successThreshold: 1,
      });

      let callCount = 0;
      const eventuallySucceeds = () => {
        callCount++;
        return cb.execute(async () => {
          if (callCount < 3) throw new Error('503 overloaded');
          return { content: 'Hello!', finishReason: 'stop' as const };
        });
      };

      const result = await retryWithBackoff<LLMResponse>(eventuallySucceeds, {
        maxRetries: 5,
        baseDelayMs: 10,
        maxDelayMs: 50,
      });

      expect(result.content).toBe('Hello!');
      expect(cb.getState()).toBe('closed');
    });
  });

  describe('rate limiter + circuit breaker integration', () => {
    it('rate limits before hitting circuit breaker', async () => {
      const limiter = new RateLimiter('anthropic', {
        maxRequests: 3,
        windowMs: 200,
      });

      const cb = new CircuitBreaker('test-llm', {
        failureThreshold: 5,
        cooldownMs: 5000,
        successThreshold: 1,
      });

      const results: string[] = [];

      // Fire 5 requests quickly — first 3 proceed, rest queue
      const promises = Array.from({ length: 5 }, async (_, i) => {
        await limiter.acquire();
        const result = await cb.execute(async () => ({ content: `response-${i}` }));
        results.push(result.content);
      });

      await Promise.all(promises);

      expect(results).toHaveLength(5);
      expect(cb.getState()).toBe('closed');

      limiter.reset();
    });
  });
});
