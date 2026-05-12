/**
 * createProvider — verifies that the 'ollama' branch resolves the model
 * through resolveOllamaModel, and that anthropic/openai branches are
 * unaffected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProvider, OllamaProvider, AnthropicProvider, OpenAIProvider } from '../../src/llm/index.js';
import type { AgentConfig } from '../../src/types.js';

const baseConfig: AgentConfig = {
  agent: { name: 'X', defaultProvider: 'ollama', model: 'should-not-be-used' },
  providers: {
    anthropic: { model: 'claude-sonnet-4', maxTokens: 4096 },
    openai: { model: 'gpt-4o', maxTokens: 4096 },
    ollama: { model: 'llama3', baseUrl: 'http://localhost:11434' },
  },
} as unknown as AgentConfig;

describe('createProvider — Ollama branch consumes resolveOllamaModel', () => {
  let tmpDir: string;
  const savedEnv = process.env['OLLAMA_MODEL'];
  const savedData = process.env['DATA_DIR'];
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-cp-'));
    process.env['DATA_DIR'] = tmpDir;
    delete process.env['OLLAMA_MODEL'];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env['OLLAMA_MODEL'];
    else process.env['OLLAMA_MODEL'] = savedEnv;
    if (savedData === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = savedData;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('uses OLLAMA_MODEL env when set', () => {
    process.env['OLLAMA_MODEL'] = 'qwen3-coder:30b';
    const p = createProvider('ollama', baseConfig) as OllamaProvider;
    expect(p.getModel()).toBe('qwen3-coder:30b');
  });

  it('falls back to routing.json forceModel when env absent', () => {
    fs.writeFileSync(path.join(tmpDir, 'routing.json'),
      JSON.stringify({ forceModel: 'qwen2.5-coder:32b' }), 'utf-8');
    const p = createProvider('ollama', baseConfig) as OllamaProvider;
    expect(p.getModel()).toBe('qwen2.5-coder:32b');
  });

  it('falls back to config model when nothing else', () => {
    const p = createProvider('ollama', baseConfig) as OllamaProvider;
    expect(p.getModel()).toBe('llama3');
  });

  it('anthropic branch is unaffected by resolver', () => {
    process.env['OLLAMA_MODEL'] = 'this-should-not-apply';
    fs.writeFileSync(path.join(tmpDir, 'routing.json'),
      JSON.stringify({ forceModel: 'nope-not-used' }), 'utf-8');
    const p = createProvider('anthropic', baseConfig) as AnthropicProvider;
    // AnthropicProvider's name getter doesn't expose .model directly, but
    // we can confirm the constructor wasn't intercepted by the Ollama
    // resolver — name is the stable identifier.
    expect(p.name).toBe('anthropic');
  });

  it('openai branch is unaffected by resolver', () => {
    process.env['OLLAMA_MODEL'] = 'this-should-not-apply';
    const p = createProvider('openai', baseConfig) as OpenAIProvider;
    expect(p.name).toBe('openai');
  });
});
