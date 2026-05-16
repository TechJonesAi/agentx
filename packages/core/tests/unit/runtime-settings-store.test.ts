/**
 * RuntimeSettingsStore unit tests — Batch 2 verification.
 *
 * Coverage:
 *  - default settings on first read
 *  - update persists to disk and survives re-instantiation
 *  - get() returns shallow copy (no internal mutation)
 *  - reset() restores defaults + persists
 *  - modelPins shallow-merge across calls
 *  - restartRequiredFor() classifies keys correctly
 *  - listeners receive updates
 *  - corrupted file falls back to defaults
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RuntimeSettingsStore,
  DEFAULT_SETTINGS,
} from '../../src/observability/runtime-settings-store.js';

let tmpDir: string;
let cfgFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-runtime-settings-'));
  cfgFile = path.join(tmpDir, 'runtime-settings.json');
}, 60_000);

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe('RuntimeSettingsStore — defaults + persistence', () => {
  it('returns default settings when no file exists', () => {
    const s = RuntimeSettingsStore.__createForTest(cfgFile);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('update() writes to disk and a fresh instance reads it back', () => {
    const s1 = RuntimeSettingsStore.__createForTest(cfgFile);
    s1.update({ localOnly: true, retrievalEnabled: false });
    expect(fs.existsSync(cfgFile)).toBe(true);

    const s2 = RuntimeSettingsStore.__createForTest(cfgFile);
    expect(s2.getKey('localOnly')).toBe(true);
    expect(s2.getKey('retrievalEnabled')).toBe(false);
    // Untouched keys keep defaults.
    expect(s2.getKey('toolCallingEnabled')).toBe(DEFAULT_SETTINGS.toolCallingEnabled);
  });

  it('reset() restores defaults and persists', () => {
    const s = RuntimeSettingsStore.__createForTest(cfgFile);
    s.update({ localOnly: true });
    s.reset();
    expect(s.getKey('localOnly')).toBe(false);
    const s2 = RuntimeSettingsStore.__createForTest(cfgFile);
    expect(s2.getKey('localOnly')).toBe(false);
  });

  it('falls back to defaults when file is corrupted', () => {
    fs.writeFileSync(cfgFile, '{ not valid json', 'utf-8');
    const s = RuntimeSettingsStore.__createForTest(cfgFile);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('RuntimeSettingsStore — model pins', () => {
  it('shallow-merges modelPins across updates', () => {
    const s = RuntimeSettingsStore.__createForTest(cfgFile);
    s.update({ modelPins: { chat: 'qwen2.5-coder:32b' } });
    s.update({ modelPins: { code: 'codellama:13b' } });
    expect(s.getKey('modelPins')).toEqual({
      chat: 'qwen2.5-coder:32b',
      code: 'codellama:13b',
    });
  });

  it('get() returns a copy — mutating the result does NOT mutate the store', () => {
    const s = RuntimeSettingsStore.__createForTest(cfgFile);
    s.update({ modelPins: { chat: 'model-A' } });
    const snap = s.get();
    snap.modelPins.chat = 'mutated';
    expect(s.getKey('modelPins').chat).toBe('model-A');
  });
});

describe('RuntimeSettingsStore — listeners', () => {
  it('notifies listeners on update + supports unsubscribe', () => {
    const s = RuntimeSettingsStore.__createForTest(cfgFile);
    const events: boolean[] = [];
    const unsub = s.onChange((next) => events.push(next.localOnly));
    s.update({ localOnly: true });
    s.update({ localOnly: false });
    unsub();
    s.update({ localOnly: true });
    expect(events).toEqual([true, false]);
  });

  it('catches throws from listeners and continues', () => {
    const s = RuntimeSettingsStore.__createForTest(cfgFile);
    s.onChange(() => { throw new Error('boom'); });
    expect(() => s.update({ localOnly: true })).not.toThrow();
    expect(s.getKey('localOnly')).toBe(true);
  });
});

describe('RuntimeSettingsStore — restart classification', () => {
  it('flags builderV2Enabled / agentLoopsEnabled as restart-required', () => {
    const out = RuntimeSettingsStore.restartRequiredFor({
      builderV2Enabled: true,
      agentLoopsEnabled: true,
      localOnly: true,
    });
    expect(out.sort()).toEqual(['agentLoopsEnabled', 'builderV2Enabled']);
  });

  it('returns empty for purely-live patches', () => {
    const out = RuntimeSettingsStore.restartRequiredFor({
      localOnly: true,
      retrievalEnabled: false,
      toolCallingEnabled: false,
      repairPolicy: 'always-ask',
    });
    expect(out).toEqual([]);
  });
});
