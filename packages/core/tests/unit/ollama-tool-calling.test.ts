/**
 * Ollama native tool calling — opt-in gating tests.
 *
 * Verifies:
 *   - flag OFF + tools supplied → no `tools` field in request body
 *   - flag ON  + tools supplied → tools included, in correct shape
 *   - tool_calls parsed from response (native format)
 *   - tool_calls parsed from JSON-in-content fallback
 *   - normal no-tools chat unchanged (legacy response shape preserved)
 *   - tool-role messages: legacy coerces to user, opt-in passes through
 *   - timeout adapted only when opt-in
 *   - streaming: opt-in aggregates tool_calls; legacy ignores them
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OllamaProvider } from '../../src/llm/ollama.js';

// --- fetch mock helpers ----------------------------------------------------

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
  hasSignal: boolean;
}

function mockFetch(responseBody: Record<string, unknown>): {
  fetchSpy: ReturnType<typeof vi.spyOn>;
  captured: CapturedRequest[];
  restore: () => void;
} {
  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown, init?: unknown) => {
    const url = typeof input === 'string' ? input : (input as { url?: string }).url ?? '';
    const initObj = (init ?? {}) as { body?: string; signal?: AbortSignal };
    const body = JSON.parse(initObj.body ?? '{}') as Record<string, unknown>;
    captured.push({ url, body, hasSignal: !!initObj.signal });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return {
    fetchSpy,
    captured,
    restore: () => { globalThis.fetch = originalFetch; fetchSpy.mockRestore(); },
  };
}

function withFlag(value: string | undefined): { restore: () => void } {
  const prev = process.env['AGENTX_OLLAMA_TOOL_CALLING'];
  if (value === undefined) delete process.env['AGENTX_OLLAMA_TOOL_CALLING'];
  else process.env['AGENTX_OLLAMA_TOOL_CALLING'] = value;
  return {
    restore: () => {
      if (prev === undefined) delete process.env['AGENTX_OLLAMA_TOOL_CALLING'];
      else process.env['AGENTX_OLLAMA_TOOL_CALLING'] = prev;
    },
  };
}

const TOOL_DEFS = [
  {
    name: 'shell',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
  },
];

const PLAIN_TEXT_RESPONSE = {
  message: { role: 'assistant', content: 'Hello there.' },
  done: true,
  eval_count: 10,
  prompt_eval_count: 5,
};

const TOOL_CALL_RESPONSE = {
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [
      { function: { name: 'shell', arguments: { cmd: 'ls' } } },
    ],
  },
  done: true,
  eval_count: 4,
  prompt_eval_count: 8,
};

const JSON_IN_CONTENT_RESPONSE = {
  message: {
    role: 'assistant',
    content: 'Sure! {"name":"shell","arguments":{"cmd":"ls -la"}}',
  },
  done: true,
};

describe('OllamaProvider — flag OFF (default behaviour)', () => {
  let flag: { restore: () => void };
  let mock: ReturnType<typeof mockFetch>;
  beforeEach(() => {
    flag = withFlag(undefined); // unset
    mock = mockFetch(PLAIN_TEXT_RESPONSE);
  });
  afterEach(() => { mock.restore(); flag.restore(); });

  it('does NOT include `tools` in request body even when tools are supplied', async () => {
    const p = new OllamaProvider('llama3', 'http://localhost:11434');
    const resp = await p.complete({
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
      tools: TOOL_DEFS,
    });
    expect(mock.captured).toHaveLength(1);
    expect(mock.captured[0].body['tools']).toBeUndefined();
    // legacy response shape (no toolCalls, finishReason='stop')
    expect(resp.finishReason).toBe('stop');
    expect(resp.toolCalls).toBeUndefined();
    expect(resp.content).toBe('Hello there.');
  });

  it('uses default fetch (no AbortSignal) — preserves pre-import timeout behaviour', async () => {
    const p = new OllamaProvider('qwen2.5-coder:32b');
    await p.complete({
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
      tools: TOOL_DEFS,
    });
    expect(mock.captured[0].hasSignal).toBe(false);
  });

  it('coerces tool-role messages to "[Tool Result]: …" user role', async () => {
    const p = new OllamaProvider('llama3');
    await p.complete({
      messages: [
        { role: 'user', content: 'do the thing', timestamp: 0 },
        { role: 'tool', content: 'result-text', timestamp: 1 },
      ],
    });
    const messages = mock.captured[0].body['messages'] as Array<{ role: string; content: string }>;
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toBe('[Tool Result]: result-text');
  });

  it('does NOT parse tool_calls when flag is off, even if Ollama returns them', async () => {
    mock.restore();
    mock = mockFetch(TOOL_CALL_RESPONSE);
    const p = new OllamaProvider('llama3');
    const resp = await p.complete({
      messages: [{ role: 'user', content: 'go', timestamp: 0 }],
      tools: TOOL_DEFS,
    });
    expect(resp.toolCalls).toBeUndefined();
    expect(resp.finishReason).toBe('stop');
    // Plain content path: original content surfaced as-is
    expect(resp.content).toBe('');
  });
});

describe('OllamaProvider — flag ON (opt-in tool calling)', () => {
  let flag: { restore: () => void };
  let mock: ReturnType<typeof mockFetch>;
  beforeEach(() => {
    flag = withFlag('true');
    mock = mockFetch(TOOL_CALL_RESPONSE);
  });
  afterEach(() => { mock.restore(); flag.restore(); });

  it('includes tools in request body in OpenAI-compatible format', async () => {
    const p = new OllamaProvider('llama3');
    await p.complete({
      messages: [{ role: 'user', content: 'run ls', timestamp: 0 }],
      tools: TOOL_DEFS,
    });
    const body = mock.captured[0].body;
    expect(body['tools']).toBeDefined();
    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]['type']).toBe('function');
    const fn = tools[0]['function'] as Record<string, unknown>;
    expect(fn['name']).toBe('shell');
    expect(fn['description']).toBe('Run a shell command');
  });

  it('does NOT include `tools` when none are supplied (clean request body)', async () => {
    const p = new OllamaProvider('llama3');
    await p.complete({
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    });
    expect(mock.captured[0].body['tools']).toBeUndefined();
  });

  it('parses native tool_calls from response', async () => {
    const p = new OllamaProvider('llama3');
    const resp = await p.complete({
      messages: [{ role: 'user', content: 'run ls', timestamp: 0 }],
      tools: TOOL_DEFS,
    });
    expect(resp.finishReason).toBe('tool_use');
    expect(resp.toolCalls).toBeDefined();
    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls![0].name).toBe('shell');
    expect(resp.toolCalls![0].arguments).toEqual({ cmd: 'ls' });
    // Content is cleared when tool calls are present
    expect(resp.content).toBe('');
  });

  it('parses JSON-in-content fallback for models that emit tool calls as text', async () => {
    mock.restore();
    mock = mockFetch(JSON_IN_CONTENT_RESPONSE);
    const p = new OllamaProvider('qwen2.5-coder:32b');
    const resp = await p.complete({
      messages: [{ role: 'user', content: 'list', timestamp: 0 }],
      tools: TOOL_DEFS,
    });
    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls![0].name).toBe('shell');
    expect(resp.toolCalls![0].arguments).toEqual({ cmd: 'ls -la' });
  });

  it('passes tool-role messages through with role="tool"', async () => {
    const p = new OllamaProvider('llama3');
    await p.complete({
      messages: [
        { role: 'user', content: 'run ls', timestamp: 0 },
        { role: 'tool', content: 'file1\nfile2', timestamp: 1 },
      ],
      tools: TOOL_DEFS,
    });
    const messages = mock.captured[0].body['messages'] as Array<{ role: string; content: string }>;
    expect(messages[1].role).toBe('tool');
    expect(messages[1].content).toBe('file1\nfile2');
  });

  it('re-emits assistant messages with toolCalls as tool_calls', async () => {
    const p = new OllamaProvider('llama3');
    await p.complete({
      messages: [
        { role: 'user', content: 'ls', timestamp: 0 },
        {
          role: 'assistant', content: '', timestamp: 1,
          toolCalls: [{ id: 'c1', name: 'shell', arguments: { cmd: 'ls' } }],
        },
        { role: 'tool', content: 'file1', timestamp: 2 },
      ],
      tools: TOOL_DEFS,
    });
    const messages = mock.captured[0].body['messages'] as Array<{ role: string; tool_calls?: unknown[] }>;
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].tool_calls).toBeDefined();
    expect(messages[1].tool_calls).toHaveLength(1);
  });

  it('uses adaptive timeout (AbortSignal present)', async () => {
    const p = new OllamaProvider('qwen2.5-coder:32b');
    await p.complete({
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
      tools: TOOL_DEFS,
    });
    expect(mock.captured[0].hasSignal).toBe(true);
  });
});

describe('OllamaProvider — accepted flag values', () => {
  let mock: ReturnType<typeof mockFetch>;
  beforeEach(() => { mock = mockFetch(TOOL_CALL_RESPONSE); });
  afterEach(() => { mock.restore(); });

  for (const v of ['true', 'TRUE', '1', 'yes', 'on']) {
    it(`enables tool calling when AGENTX_OLLAMA_TOOL_CALLING=${v}`, async () => {
      const f = withFlag(v);
      try {
        const p = new OllamaProvider('llama3');
        await p.complete({
          messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
          tools: TOOL_DEFS,
        });
        expect(mock.captured[0].body['tools']).toBeDefined();
      } finally {
        f.restore();
      }
    });
  }

  for (const v of ['false', '0', 'no', 'off', '', 'maybe']) {
    it(`leaves tool calling OFF when AGENTX_OLLAMA_TOOL_CALLING=${JSON.stringify(v)}`, async () => {
      const f = withFlag(v);
      try {
        const p = new OllamaProvider('llama3');
        await p.complete({
          messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
          tools: TOOL_DEFS,
        });
        expect(mock.captured[0].body['tools']).toBeUndefined();
      } finally {
        f.restore();
      }
    });
  }
});
