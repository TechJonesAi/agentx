/**
 * P12-4 — Tool Forge tests.
 *
 * Heavy emphasis on the security boundary:
 *   - deny-list rejects dangerous drafts BEFORE storage
 *   - the vm sandbox exposes no host capabilities
 *   - pending / disabled tools can never execute
 *   - infinite loops are killed by the timeout
 *   - repeated failures auto-disable + unregister
 * Plus the lifecycle: draft → approve → run → provenance → boot reload.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ToolForge, buildForgeDraftTool, buildForgeListTool } from '../../src/tools/tool-forge.js';
import { ToolRegistry } from '../../src/tools/registry.js';

function makeForge(): { forge: ToolForge; registry: ToolRegistry; db: Database.Database } {
  const db = new Database(':memory:');
  const registry = new ToolRegistry();
  const forge = new ToolForge(db, registry);
  return { forge, registry, db };
}

const GOOD_TOOL = {
  name: 'add_days',
  description: 'Add N days to an ISO date and return the new ISO date string',
  paramsSchema: { type: 'object', properties: { date: { type: 'string' }, days: { type: 'number' } }, required: ['date', 'days'] },
  sourceCode: `
    const d = new Date(args.date);
    d.setDate(d.getDate() + Number(args.days));
    return d.toISOString().slice(0, 10);
  `,
};

describe('P12-4 draft validation (security gate 1)', () => {
  it('accepts a valid pure-compute draft as pending', () => {
    const { forge } = makeForge();
    const r = forge.draftTool(GOOD_TOOL);
    expect(r.ok).toBe(true);
    expect(forge.getTool('add_days')!.status).toBe('pending');
  });

  it.each([
    ['require', 'return require("fs")'],
    ['process', 'return process.env'],
    ['eval', 'return eval("1+1")'],
    ['new Function', 'const f = new Function("return 1"); return f()'],
    ['fetch', 'return fetch("http://x")'],
    ['globalThis', 'return globalThis'],
    ['__proto__', 'return ({}).__proto__'],
    ['setTimeout', 'setTimeout(()=>{},1); return 1'],
    ['child_process', 'return child_process'],
  ])('rejects draft containing %s', (_label, source) => {
    const { forge } = makeForge();
    const r = forge.draftTool({ ...GOOD_TOOL, name: 'evil_tool', sourceCode: source });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('forbidden token');
    expect(forge.getTool('evil_tool')).toBeNull(); // never stored
  });

  it('rejects bad names, short descriptions, missing return, syntax errors', () => {
    const { forge } = makeForge();
    expect(forge.draftTool({ ...GOOD_TOOL, name: 'Bad-Name!' }).ok).toBe(false);
    expect(forge.draftTool({ ...GOOD_TOOL, name: 'ok_name', description: 'short' }).ok).toBe(false);
    expect(forge.draftTool({ ...GOOD_TOOL, name: 'no_return', sourceCode: 'const x = 1;' }).ok).toBe(false);
    expect(forge.draftTool({ ...GOOD_TOOL, name: 'syntax_err', sourceCode: 'return {{{' }).ok).toBe(false);
  });
});

describe('P12-4 lifecycle + execution', () => {
  it('pending tools cannot execute', () => {
    const { forge } = makeForge();
    forge.draftTool(GOOD_TOOL);
    const out = forge.runSandboxed('add_days', { date: '2026-03-01', days: 13 });
    expect(out).toContain('pending');
    expect(out).toContain('not executable');
  });

  it('approve → registers into ToolRegistry → runs correctly', async () => {
    const { forge, registry } = makeForge();
    forge.draftTool(GOOD_TOOL);
    const a = forge.approveTool('add_days');
    expect(a.ok).toBe(true);
    expect(registry.getDefinitions().some((d) => d.name === 'add_days')).toBe(true);
    const out = await registry.execute('add_days', { date: '2026-03-01', days: 13 }, { sessionId: 's1', agent: {} as any });
    expect(out).toBe('2026-03-14');
  });

  it('sandbox has no host capabilities at runtime (defence-in-depth)', () => {
    const { forge, db } = makeForge();
    // Bypass the draft deny-list by inserting directly (simulating a
    // tampered row) — the SANDBOX must still contain the blast radius.
    db.prepare(`INSERT INTO custom_tools (name, description, params_schema_json, source_code, status) VALUES ('sneaky','direct insert bypassing draft','{}','return typeof process', 'approved')`).run();
    const out = forge.runSandboxed('sneaky', {});
    expect(out).toBe('undefined'); // typeof process === 'undefined' in the sandbox
  });

  it('infinite loop is killed by the 1s timeout', () => {
    const { forge, db } = makeForge();
    db.prepare(`INSERT INTO custom_tools (name, description, params_schema_json, source_code, status) VALUES ('spinner','loops forever for testing','{}','while(true){}; return 1', 'approved')`).run();
    const start = Date.now();
    const out = forge.runSandboxed('spinner', {});
    expect(Date.now() - start).toBeLessThan(3000);
    expect(out).toContain('Error');
  });

  it('3 consecutive failures auto-disable and unregister the tool', () => {
    const { forge, registry, db } = makeForge();
    db.prepare(`INSERT INTO custom_tools (name, description, params_schema_json, source_code, status) VALUES ('flaky','always throws for testing','{}','throw new Error("boom"); return 1', 'approved')`).run();
    registry.register({ definition: { name: 'flaky', description: 'x', parameters: {} }, execute: async () => forge.runSandboxed('flaky', {}) });
    forge.runSandboxed('flaky', {});
    forge.runSandboxed('flaky', {});
    forge.runSandboxed('flaky', {});
    const row = forge.getTool('flaky')!;
    expect(row.status).toBe('disabled');
    expect(row.disabled_reason).toContain('auto-disabled');
    expect(registry.getDefinitions().some((d) => d.name === 'flaky')).toBe(false);
  });

  it('provenance: every run is logged with outcome + latency', () => {
    const { forge, db } = makeForge();
    forge.draftTool(GOOD_TOOL);
    forge.approveTool('add_days');
    forge.runSandboxed('add_days', { date: '2026-01-01', days: 1 });
    const runs = db.prepare('SELECT * FROM custom_tool_runs').all() as Array<{ tool_name: string; ok: number; latency_ms: number }>;
    expect(runs.length).toBe(1);
    expect(runs[0]!.ok).toBe(1);
    expect(runs[0]!.tool_name).toBe('add_days');
  });

  it('loadApprovedTools re-registers approved tools at boot', () => {
    const { forge, db } = makeForge();
    forge.draftTool(GOOD_TOOL);
    forge.approveTool('add_days');
    // Simulate a fresh boot: new registry + forge on the same db
    const registry2 = new ToolRegistry();
    const forge2 = new ToolForge(db, registry2);
    const n = forge2.loadApprovedTools();
    expect(n).toBe(1);
    expect(registry2.getDefinitions().some((d) => d.name === 'add_days')).toBe(true);
  });

  it('re-drafting an approved tool demotes it to pending and unregisters it', () => {
    const { forge, registry } = makeForge();
    forge.draftTool(GOOD_TOOL);
    forge.approveTool('add_days');
    forge.draftTool({ ...GOOD_TOOL, sourceCode: 'return "v2 " + args.date;' });
    expect(forge.getTool('add_days')!.status).toBe('pending');
    expect(registry.getDefinitions().some((d) => d.name === 'add_days')).toBe(false);
  });
});

describe('P12-4 built-in forge tools (LLM-facing)', () => {
  it('forge_tool drafts pending; list_custom_tools reflects it', async () => {
    const { forge } = makeForge();
    const draft = buildForgeDraftTool(forge);
    const list = buildForgeListTool(forge);
    const msg = await draft.execute(
      { name: 'percent_change', description: 'Compute percent change between two numbers', sourceCode: 'return ((args.b - args.a) / args.a * 100).toFixed(2) + "%";' },
      { sessionId: 's', agent: {} as any },
    );
    expect(msg).toContain('PENDING');
    expect(msg).toContain('human must approve');
    const listing = await list.execute({}, { sessionId: 's', agent: {} as any });
    expect(listing).toContain('percent_change [pending]');
  });

  it('forge_tool surfaces validation errors to the model', async () => {
    const { forge } = makeForge();
    const draft = buildForgeDraftTool(forge);
    const msg = await draft.execute(
      { name: 'evil', description: 'try to escape sandbox now', sourceCode: 'return process.env' },
      { sessionId: 's', agent: {} as any },
    );
    expect(msg).toContain('Draft rejected');
    expect(msg).toContain('forbidden token');
  });
});
