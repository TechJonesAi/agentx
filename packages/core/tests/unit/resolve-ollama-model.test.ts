/**
 * resolveOllamaModel — priority order tests.
 *
 *   1. OLLAMA_MODEL env
 *   2. routing.json forceModel
 *   3. config model
 *   4. 'llama3' default
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveOllamaModel } from '../../src/llm/resolve-ollama-model.js';

describe('resolveOllamaModel', () => {
  let tmpDir: string;
  const savedEnv = process.env['OLLAMA_MODEL'];
  const savedData = process.env['DATA_DIR'];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-resolve-'));
    delete process.env['OLLAMA_MODEL'];
    process.env['DATA_DIR'] = tmpDir;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env['OLLAMA_MODEL'];
    else process.env['OLLAMA_MODEL'] = savedEnv;
    if (savedData === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = savedData;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('1. OLLAMA_MODEL env wins over everything', () => {
    process.env['OLLAMA_MODEL'] = 'qwen3-coder:30b';
    fs.writeFileSync(path.join(tmpDir, 'routing.json'),
      JSON.stringify({ forceModel: 'llama3.3:70b' }), 'utf-8');
    const r = resolveOllamaModel('config-model', { dataDir: tmpDir });
    expect(r.model).toBe('qwen3-coder:30b');
    expect(r.source).toBe('env');
  });

  it('2. routing.json forceModel used when env absent', () => {
    fs.writeFileSync(path.join(tmpDir, 'routing.json'),
      JSON.stringify({ mode: 'LOCAL_ONLY', forceModel: 'qwen2.5-coder:32b' }), 'utf-8');
    const r = resolveOllamaModel('config-model', { dataDir: tmpDir });
    expect(r.model).toBe('qwen2.5-coder:32b');
    expect(r.source).toBe('routing.json');
  });

  it('3. config model used when no env and no forceModel', () => {
    fs.writeFileSync(path.join(tmpDir, 'routing.json'),
      JSON.stringify({ mode: 'LOCAL_ONLY' }), 'utf-8');
    const r = resolveOllamaModel('config-model', { dataDir: tmpDir });
    expect(r.model).toBe('config-model');
    expect(r.source).toBe('config');
  });

  it('3b. config model used when routing.json missing entirely', () => {
    const r = resolveOllamaModel('my-model', { dataDir: tmpDir });
    expect(r.model).toBe('my-model');
    expect(r.source).toBe('config');
  });

  it('4. falls back to llama3 when no env, no forceModel, no config', () => {
    const r = resolveOllamaModel(undefined, { dataDir: tmpDir });
    expect(r.model).toBe('llama3');
    expect(r.source).toBe('default');
  });

  it('4b. empty-string config model is treated as absent', () => {
    const r = resolveOllamaModel('', { dataDir: tmpDir });
    expect(r.model).toBe('llama3');
    expect(r.source).toBe('default');
  });

  it('empty-string env var falls through to next layer', () => {
    process.env['OLLAMA_MODEL'] = '';
    fs.writeFileSync(path.join(tmpDir, 'routing.json'),
      JSON.stringify({ forceModel: 'qwen2.5-coder:32b' }), 'utf-8');
    const r = resolveOllamaModel('config-model', { dataDir: tmpDir });
    expect(r.model).toBe('qwen2.5-coder:32b');
    expect(r.source).toBe('routing.json');
  });

  it('whitespace-only env var falls through to next layer', () => {
    process.env['OLLAMA_MODEL'] = '   ';
    fs.writeFileSync(path.join(tmpDir, 'routing.json'),
      JSON.stringify({ forceModel: 'qwen2.5-coder:32b' }), 'utf-8');
    const r = resolveOllamaModel('config-model', { dataDir: tmpDir });
    expect(r.model).toBe('qwen2.5-coder:32b');
  });

  it('empty forceModel is treated as absent', () => {
    fs.writeFileSync(path.join(tmpDir, 'routing.json'),
      JSON.stringify({ mode: 'LOCAL_ONLY', forceModel: '' }), 'utf-8');
    const r = resolveOllamaModel('config-model', { dataDir: tmpDir });
    expect(r.model).toBe('config-model');
    expect(r.source).toBe('config');
  });

  it('malformed routing.json falls back to config without throwing', () => {
    fs.writeFileSync(path.join(tmpDir, 'routing.json'), 'this is not json', 'utf-8');
    const r = resolveOllamaModel('config-model', { dataDir: tmpDir });
    expect(r.model).toBe('config-model');
    expect(r.source).toBe('config');
  });

  it('trims whitespace around env value', () => {
    process.env['OLLAMA_MODEL'] = '  qwen2.5-coder:32b  ';
    const r = resolveOllamaModel(undefined, { dataDir: tmpDir });
    expect(r.model).toBe('qwen2.5-coder:32b');
    expect(r.source).toBe('env');
  });
});
