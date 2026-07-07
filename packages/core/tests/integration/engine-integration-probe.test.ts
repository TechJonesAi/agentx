/**
 * Engine Integration health probe — regression for the v1.2.0 verification
 * blocker where the self-healing panel showed DEGRADED while the header
 * showed HEALTHY.
 *
 * Root cause: the probe reported `degraded` whenever the AgentLoopEngine
 * had not yet been LAZILY instantiated — which is the normal healthy idle
 * state (the engine is built on first use and always wires the
 * WorkflowRunStore by construction). A not-yet-used lazy component is not a
 * fault, so the probe must report `ok` when its wiring dependency is
 * available, and only `failed` when it genuinely isn't.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent.js';

function writeConfig(dir: string): string {
  const yaml = [
    'agent:',
    '  name: AgentX-Test',
    '  defaultProvider: ollama',
    '  model: llama3',
    'providers:',
    '  ollama:',
    '    model: llama3',
    '    baseUrl: http://localhost:11434',
    'memory:',
    '  maxConversationHistory: 100',
    '  summarizeAfter: 50',
    '  embeddingProvider: local',
    'sessions:',
    '  persistToDisk: false',
    '  ttlMinutes: 60',
    'health:',
    '  enabled: false',
    '  port: 9090',
    '',
  ].join('\n');
  const p = path.join(dir, 'agentx.yaml');
  fs.writeFileSync(p, yaml, 'utf-8');
  return p;
}

let tmpDir: string;
let prevDataDir: string | undefined;
let agent: Agent;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-engint-'));
  prevDataDir = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = tmpDir;
  agent = new Agent(writeConfig(tmpDir));
});

afterEach(async () => {
  await agent.shutdown?.();
  if (prevDataDir === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = prevDataDir;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('Engine Integration health probe', () => {
  it('reports OK (not degraded) when the AgentLoopEngine is lazily uninstantiated', async () => {
    const monitor = agent.getHealthMonitor();
    await monitor.runAll();
    const snap = monitor.snapshot();
    const engine = snap.subsystems.find((s) => s.name === 'Engine Integration');
    expect(engine).toBeDefined();
    // The engine has NOT been used yet (no runAgentLoop called), so it is
    // lazily uninstantiated — the healthy idle state. Must be ok, never
    // degraded, because the WorkflowRunStore dependency is available.
    expect(engine?.lastStatus).toBe('ok');
    expect(String(engine?.lastDetail)).toMatch(/WorkflowRunStore/i);
  });

  it('overall health is not dragged to degraded by an unused lazy engine', async () => {
    const monitor = agent.getHealthMonitor();
    await monitor.runAll();
    const snap = monitor.snapshot();
    // No subsystem should be `degraded` purely due to lazy init.
    const degradedByLazy = snap.subsystems.filter(
      (s) => s.lastStatus === 'degraded' && /not yet instantiated|lazy/i.test(String(s.lastDetail)),
    );
    expect(degradedByLazy).toEqual([]);
  });
});
