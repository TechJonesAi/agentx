/**
 * Proactive digest — AgentX initiates contact instead of only answering.
 *
 * Composes a daily summary from real stores (conversations, builds, agent
 * loops, learning events, service health), persists it, and raises a macOS
 * notification. This is the "personal assistant" behaviour the top-tier
 * agents advertise: the user hears from AgentX without asking.
 *
 * Cadence: first digest 5 minutes after boot (so a morning launch greets
 * you with yesterday's summary), then every 24h. Manual: POST /api/digest/run.
 * Disable: AGENTX_DIGEST=false.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { createLogger } from '@agentx/core';

const log = createLogger('web:digest');

const DIGEST_FILE = path.join(os.homedir(), '.agentx', 'digests.json');

interface DbLike {
  prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
}

export interface Digest {
  at: number;
  headline: string;
  lines: string[];
}

function count(db: DbLike, sql: string, ...args: unknown[]): number {
  try {
    const r = db.prepare(sql).get(...args) as { n?: number } | undefined;
    return Number(r?.n ?? 0);
  } catch { return 0; }
}

export function composeDigest(db: DbLike): Digest {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const lines: string[] = [];

  const msgs = count(db, 'SELECT count(*) n FROM messages WHERE timestamp > ?', dayAgo);
  const sessions = count(db, 'SELECT count(DISTINCT session_id) n FROM messages WHERE timestamp > ?', dayAgo);
  if (msgs > 0) lines.push(`💬 ${msgs} messages across ${sessions} conversation${sessions === 1 ? '' : 's'}`);

  const builds = count(db,
    "SELECT count(*) n FROM global_learning_events WHERE subsystem = 'build' AND created_at > datetime(?, 'unixepoch')", Math.floor(dayAgo / 1000));
  const buildOk = count(db,
    "SELECT count(*) n FROM global_learning_events WHERE subsystem = 'build' AND outcome = 'success' AND created_at > datetime(?, 'unixepoch')", Math.floor(dayAgo / 1000));
  if (builds > 0) lines.push(`🔨 ${builds} app build${builds === 1 ? '' : 's'} (${buildOk} succeeded)`);

  const learned = count(db,
    "SELECT count(*) n FROM global_learning_events WHERE created_at > datetime(?, 'unixepoch')", Math.floor(dayAgo / 1000));
  if (learned > 0) lines.push(`🧠 ${learned} learning events recorded`);

  const playbooks = count(db, 'SELECT count(*) n FROM playbooks');
  if (playbooks > 0) lines.push(`📘 ${playbooks} playbooks in success memory`);

  const docs = count(db, 'SELECT count(*) n FROM documents');
  if (docs > 0) lines.push(`📄 ${docs} documents in the corpus`);

  if (lines.length === 0) lines.push('Quiet day — no activity recorded.');

  const headline = msgs > 0
    ? `AgentX daily digest: ${msgs} messages, ${builds} builds`
    : 'AgentX daily digest: all quiet';
  return { at: Date.now(), headline, lines };
}

export function persistDigest(d: Digest): void {
  let all: Digest[] = [];
  try { all = JSON.parse(fs.readFileSync(DIGEST_FILE, 'utf-8')) as Digest[]; } catch { /* fresh */ }
  all.unshift(d);
  fs.mkdirSync(path.dirname(DIGEST_FILE), { recursive: true });
  fs.writeFileSync(DIGEST_FILE, JSON.stringify(all.slice(0, 30), null, 2));
}

export function latestDigests(limit = 7): Digest[] {
  try {
    return (JSON.parse(fs.readFileSync(DIGEST_FILE, 'utf-8')) as Digest[]).slice(0, limit);
  } catch { return []; }
}

function notifyMac(title: string, body: string): void {
  if (process.platform !== 'darwin') return;
  try {
    const script = `display notification ${JSON.stringify(body.slice(0, 180))} with title ${JSON.stringify(title.slice(0, 60))} sound name "Glass"`;
    spawn('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' }).on('error', () => undefined);
  } catch { /* notification is best-effort */ }
}

export function runDigest(db: DbLike, notify = true): Digest {
  const d = composeDigest(db);
  persistDigest(d);
  if (notify) notifyMac('AgentX', `${d.headline}\n${d.lines[0] ?? ''}`);
  log.info({ headline: d.headline, lines: d.lines.length }, 'Digest generated');
  return d;
}

/** Start the daily digest loop. First run 5 min after boot, then every 24h. */
export function startDigest(getDb: () => DbLike | null): () => void {
  if ((process.env['AGENTX_DIGEST'] ?? 'true').toLowerCase() === 'false') {
    log.info('Digest disabled by env');
    return () => undefined;
  }
  const run = () => {
    const db = getDb();
    if (!db) return;
    try { runDigest(db); } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'Digest failed');
    }
  };
  const first = setTimeout(run, 5 * 60 * 1000);
  const interval = setInterval(run, 24 * 60 * 60 * 1000);
  first.unref?.(); interval.unref?.();
  return () => { clearTimeout(first); clearInterval(interval); };
}
