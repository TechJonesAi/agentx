import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextManager, estimateTokens, estimateMessageTokens } from '../../src/context-manager.js';
import type { Message } from '../../src/types.js';

function makeMessage(content: string, role: 'user' | 'assistant' = 'user'): Message {
  return { role, content, timestamp: Date.now() };
}

function makeLongMessages(count: number, contentLength = 1000): Message[] {
  return Array.from({ length: count }, (_, i) =>
    makeMessage('x'.repeat(contentLength), i % 2 === 0 ? 'user' : 'assistant'),
  );
}

describe('estimateTokens', () => {
  it('estimates based on ~3.8 chars per token', () => {
    const tokens = estimateTokens('Hello, world!'); // 13 chars
    expect(tokens).toBe(Math.ceil(13 / 3.8));
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('estimateMessageTokens', () => {
  it('includes role overhead (~4 tokens)', () => {
    const tokens = estimateMessageTokens(makeMessage(''));
    expect(tokens).toBe(4); // empty content + 4 overhead
  });

  it('includes tool call overhead', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'ok',
      toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'hello' } }],
      timestamp: Date.now(),
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(estimateMessageTokens(makeMessage('ok', 'assistant')));
  });
});

describe('ContextManager', () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = new ContextManager('anthropic');
  });

  describe('constructor', () => {
    it('uses Anthropic defaults (200k context)', () => {
      const config = cm.getConfig();
      expect(config.maxContextTokens).toBe(200_000);
    });

    it('uses OpenAI defaults (128k context)', () => {
      const openai = new ContextManager('openai');
      expect(openai.getConfig().maxContextTokens).toBe(128_000);
    });

    it('uses Ollama defaults (8k context)', () => {
      const ollama = new ContextManager('ollama');
      expect(ollama.getConfig().maxContextTokens).toBe(8_000);
    });

    it('allows config overrides', () => {
      const custom = new ContextManager('anthropic', { maxContextTokens: 50_000 });
      expect(custom.getConfig().maxContextTokens).toBe(50_000);
    });
  });

  describe('getMessageBudget', () => {
    it('subtracts reserved output and system prompt tokens', () => {
      const config = cm.getConfig();
      const expected = config.maxContextTokens - config.reservedOutputTokens - config.systemPromptTokens;
      expect(cm.getMessageBudget()).toBe(expected);
    });
  });

  describe('needsSummarization', () => {
    it('returns false for short conversations', () => {
      const msgs = [makeMessage('Hello'), makeMessage('Hi there', 'assistant')];
      expect(cm.needsSummarization(msgs)).toBe(false);
    });

    it('returns true when messages exceed threshold', () => {
      // Create messages that exceed 80% of budget
      const budget = cm.getMessageBudget();
      const threshold = budget * 0.8;
      // Each char is ~0.26 tokens, plus 4 per msg overhead
      const charsNeeded = Math.ceil(threshold * 3.8) + 1000;
      const msgs = [makeMessage('x'.repeat(charsNeeded))];
      expect(cm.needsSummarization(msgs)).toBe(true);
    });
  });

  describe('prepareContext', () => {
    it('returns all messages when within budget', async () => {
      const msgs = [makeMessage('Hello'), makeMessage('Hi', 'assistant')];
      const result = await cm.prepareContext('session1', msgs);

      expect(result.messages).toEqual(msgs);
      expect(result.wasTruncated).toBe(false);
      expect(result.summaryAdded).toBe(false);
    });

    it('truncates when over budget (no summarizer)', async () => {
      // Use a tiny context window
      const small = new ContextManager('ollama', {
        maxContextTokens: 200,
        reservedOutputTokens: 50,
        systemPromptTokens: 50,
        keepRecentMessages: 5,
      });

      const msgs = makeLongMessages(50, 500);
      const result = await small.prepareContext('session1', msgs);

      expect(result.wasTruncated).toBe(true);
      expect(result.messages.length).toBeLessThan(50);
    });

    it('adds summary when summarizer is set', async () => {
      const small = new ContextManager('ollama', {
        maxContextTokens: 500,
        reservedOutputTokens: 50,
        systemPromptTokens: 50,
        keepRecentMessages: 3,
      });

      const summarizer = vi.fn().mockResolvedValue('Summary of earlier conversation.');
      small.setSummarizer(summarizer);

      const msgs = makeLongMessages(20, 200);
      const result = await small.prepareContext('session1', msgs);

      expect(result.wasTruncated).toBe(true);
      expect(result.summaryAdded).toBe(true);
      expect(result.messages[0]!.role).toBe('system');
      expect(result.messages[0]!.content).toContain('Conversation Summary');
      expect(summarizer).toHaveBeenCalledOnce();
    });

    it('caches summaries across calls', async () => {
      const small = new ContextManager('ollama', {
        maxContextTokens: 500,
        reservedOutputTokens: 50,
        systemPromptTokens: 50,
        keepRecentMessages: 3,
      });

      const summarizer = vi.fn().mockResolvedValue('Summary');
      small.setSummarizer(summarizer);

      const msgs = makeLongMessages(20, 200);
      await small.prepareContext('session1', msgs);
      await small.prepareContext('session1', msgs);

      expect(summarizer).toHaveBeenCalledOnce(); // Second call uses cache
    });
  });

  describe('invalidateSummary', () => {
    it('forces re-summarization on next call', async () => {
      const small = new ContextManager('ollama', {
        maxContextTokens: 500,
        reservedOutputTokens: 50,
        systemPromptTokens: 50,
        keepRecentMessages: 3,
      });

      const summarizer = vi.fn().mockResolvedValue('Summary');
      small.setSummarizer(summarizer);

      const msgs = makeLongMessages(20, 200);
      await small.prepareContext('session1', msgs);
      small.invalidateSummary('session1');
      await small.prepareContext('session1', msgs);

      expect(summarizer).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateConfig', () => {
    it('updates config at runtime', () => {
      cm.updateConfig({ maxContextTokens: 50_000 });
      expect(cm.getConfig().maxContextTokens).toBe(50_000);
    });
  });

  describe('setProviderLimit', () => {
    it('sets context limit based on provider', () => {
      cm.setProviderLimit('openai');
      expect(cm.getConfig().maxContextTokens).toBe(128_000);
    });

    it('ignores unknown provider', () => {
      const before = cm.getConfig().maxContextTokens;
      cm.setProviderLimit('unknown');
      expect(cm.getConfig().maxContextTokens).toBe(before);
    });
  });
});
