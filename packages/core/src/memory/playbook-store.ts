// ---------------------------------------------------------------------------
// P12-3 — Playbooks: success memory ("remember the best way to win").
//
// Every completed chat turn teaches AgentX something: which model served
// which kind of request, whether retrieval helped, and — when the user
// rates a response — whether the outcome was actually good. A playbook
// is the distilled record of that experience, keyed by
// (task_type, query-signature):
//
//   recordOutcome()  — after each successful turn, upsert the matching
//                      playbook: increment use/success counters, refresh
//                      the model + approach fields.
//   applyFeedback()  — thumbs-up/down strongly moves the confidence of
//                      the playbook that produced the rated response.
//   findBest()       — before answering, look up the highest-confidence
//                      playbook whose signature overlaps the new query.
//                      The caller uses it two ways:
//                        1. hint  — a one-line "proven approach" block
//                           injected into the system prompt (always,
//                           when matched);
//                        2. model — bias routing toward the playbook's
//                           model, ONLY when confidence ≥ 0.8 with ≥ 3
//                           successes (strong evidence gate).
//
// Confidence = successes / uses, shrunk toward 0.5 for small samples
// (Laplace smoothing) and moved sharply by explicit user feedback.
//
// Pure-local SQLite on the agent DB. Best-effort everywhere: a failure
// in this layer must never affect a chat turn.
// ---------------------------------------------------------------------------

import type BetterSqlite3 from 'better-sqlite3';
import { createLogger } from '../logger.js';

const log = createLogger('memory:playbooks');

export interface PlaybookRow {
  id: number;
  task_type: string;
  signature: string;
  model: string | null;
  approach_hint: string | null;
  sample_query: string | null;
  use_count: number;
  success_count: number;
  failure_count: number;
  confidence: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlaybookMatch {
  playbook: PlaybookRow;
  /** Jaccard overlap between query tokens and playbook signature [0,1]. */
  overlap: number;
  /** True when the evidence gate for MODEL biasing is met. */
  modelBiasEligible: boolean;
}

export interface OutcomeInput {
  taskType: string;
  query: string;
  model: string;
  /** True when the turn completed without error / fallback. */
  success: boolean;
  /** Optional context notes folded into the approach hint. */
  retrievalSource?: string | null;
  retrievalMatchCount?: number | null;
  responseChars?: number;
  sessionId?: string | null;
}

const STOP = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'but',
  'is', 'are', 'was', 'were', 'be', 'have', 'has', 'do', 'does', 'did',
  'what', 'which', 'who', 'why', 'how', 'when', 'where', 'this', 'that',
  'with', 'from', 'by', 'about', 'as', 'into', 'me', 'my', 'you', 'your',
  'please', 'can', 'could', 'will', 'would', 'should', 'tell', 'give',
]);

/** Normalise a query into a stable signature: top content tokens, sorted. */
export function querySignature(query: string, maxTokens = 6): string {
  const tokens = (query ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
  // Frequency-ranked, then alphabetical for stability.
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTokens)
    .map(([t]) => t)
    .sort()
    .join(' ');
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Laplace-smoothed confidence: pulls small samples toward 0.5. */
function computeConfidence(successes: number, uses: number): number {
  return Math.round(((successes + 1) / (uses + 2)) * 100) / 100;
}

export class PlaybookStore {
  constructor(private db: BetterSqlite3.Database) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS playbooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_type TEXT NOT NULL,
        signature TEXT NOT NULL,
        model TEXT,
        approach_hint TEXT,
        sample_query TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0.5,
        last_used_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(task_type, signature)
      );
      CREATE INDEX IF NOT EXISTS idx_playbooks_task ON playbooks(task_type);
      CREATE INDEX IF NOT EXISTS idx_playbooks_conf ON playbooks(confidence);
    `);
  }

  /* ── Learning: record what happened ─────────────────────────────── */

  recordOutcome(input: OutcomeInput): void {
    try {
      const signature = querySignature(input.query);
      if (!signature) return; // nothing distinctive to learn from
      const hint = this.buildHint(input);
      const existing = this.db
        .prepare('SELECT * FROM playbooks WHERE task_type = ? AND signature = ?')
        .get(input.taskType, signature) as PlaybookRow | undefined;

      if (existing) {
        const use = existing.use_count + 1;
        const succ = existing.success_count + (input.success ? 1 : 0);
        const fail = existing.failure_count + (input.success ? 0 : 1);
        this.db
          .prepare(`
            UPDATE playbooks SET
              use_count = ?, success_count = ?, failure_count = ?,
              confidence = ?,
              model = CASE WHEN ? = 1 THEN ? ELSE model END,
              approach_hint = CASE WHEN ? = 1 THEN ? ELSE approach_hint END,
              last_used_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .run(
            use, succ, fail,
            computeConfidence(succ, use),
            input.success ? 1 : 0, input.model,
            input.success ? 1 : 0, hint,
            existing.id,
          );
      } else {
        this.db
          .prepare(`
            INSERT INTO playbooks
              (task_type, signature, model, approach_hint, sample_query,
               use_count, success_count, failure_count, confidence, last_used_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, CURRENT_TIMESTAMP)
          `)
          .run(
            input.taskType,
            signature,
            input.model,
            hint,
            (input.query ?? '').slice(0, 300),
            input.success ? 1 : 0,
            input.success ? 0 : 1,
            computeConfidence(input.success ? 1 : 0, 1),
          );
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'recordOutcome failed — learning skipped for this turn',
      );
    }
  }

  private buildHint(input: OutcomeInput): string {
    const parts: string[] = [`model=${input.model}`];
    if (input.retrievalSource) {
      parts.push(`retrieval=${input.retrievalSource}${typeof input.retrievalMatchCount === 'number' ? `(${input.retrievalMatchCount} matches)` : ''}`);
    }
    if (typeof input.responseChars === 'number') {
      const bucket = input.responseChars < 400 ? 'concise' : input.responseChars < 1600 ? 'moderate' : 'detailed';
      parts.push(`style=${bucket}`);
    }
    return parts.join(' · ').slice(0, 240);
  }

  /* ── Feedback: user verdicts move confidence hard ───────────────── */

  /**
   * Apply a thumbs-up/down to the playbook matching the rated query.
   * Up: +2 successes. Down: +2 failures AND clear the model field when
   * confidence drops below 0.4 — a badly-rated approach must not keep
   * biasing routing.
   */
  applyFeedback(taskType: string, query: string, positive: boolean): boolean {
    try {
      const signature = querySignature(query);
      if (!signature) return false;
      const row = this.db
        .prepare('SELECT * FROM playbooks WHERE task_type = ? AND signature = ?')
        .get(taskType, signature) as PlaybookRow | undefined;
      if (!row) return false;
      const succ = row.success_count + (positive ? 2 : 0);
      const fail = row.failure_count + (positive ? 0 : 2);
      const use = row.use_count + 2;
      const conf = computeConfidence(succ, use);
      this.db
        .prepare(`
          UPDATE playbooks SET
            use_count = ?, success_count = ?, failure_count = ?, confidence = ?,
            model = CASE WHEN ? < 0.4 THEN NULL ELSE model END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(use, succ, fail, conf, conf, row.id);
      log.info({ taskType, signature, positive, confidence: conf }, 'P12-3: playbook feedback applied');
      return true;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'applyFeedback failed',
      );
      return false;
    }
  }

  /* ── Recall: find the proven approach ───────────────────────────── */

  /**
   * Highest-confidence playbook of the same task type whose signature
   * overlaps the query (Jaccard ≥ 0.5). Requires ≥ 2 uses so single
   * accidents don't become doctrine. Returns null when nothing matches.
   */
  findBest(taskType: string, query: string): PlaybookMatch | null {
    try {
      const qTokens = new Set(querySignature(query, 10).split(' ').filter(Boolean));
      if (qTokens.size === 0) return null;
      const candidates = this.db
        .prepare(`
          SELECT * FROM playbooks
          WHERE task_type = ? AND use_count >= 2
          ORDER BY confidence DESC, use_count DESC
          LIMIT 40
        `)
        .all(taskType) as PlaybookRow[];
      let best: PlaybookMatch | null = null;
      for (const p of candidates) {
        const overlap = jaccard(qTokens, new Set(p.signature.split(' ')));
        if (overlap < 0.5) continue;
        const score = overlap * p.confidence;
        if (!best || score > best.overlap * best.playbook.confidence) {
          best = {
            playbook: p,
            overlap: Math.round(overlap * 100) / 100,
            modelBiasEligible: p.confidence >= 0.8 && p.success_count >= 3 && !!p.model,
          };
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  /** Render the "proven approach" prompt block (≤ 300 chars). */
  renderHintBlock(match: PlaybookMatch): string {
    const p = match.playbook;
    return (
      `\n\n[Proven approach — ${p.success_count}/${p.use_count} past successes on similar requests]\n` +
      `${(p.approach_hint ?? '').slice(0, 200)}`
    ).slice(0, 300);
  }

  /* ── Introspection ──────────────────────────────────────────────── */

  list(opts: { taskType?: string; limit?: number } = {}): PlaybookRow[] {
    try {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
      if (opts.taskType) {
        return this.db
          .prepare('SELECT * FROM playbooks WHERE task_type = ? ORDER BY confidence DESC LIMIT ?')
          .all(opts.taskType, limit) as PlaybookRow[];
      }
      return this.db
        .prepare('SELECT * FROM playbooks ORDER BY confidence DESC, use_count DESC LIMIT ?')
        .all(limit) as PlaybookRow[];
    } catch {
      return [];
    }
  }

  getStats(): { playbooks: number; totalUses: number; avgConfidence: number } {
    try {
      const r = this.db
        .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(use_count),0) AS uses, COALESCE(AVG(confidence),0) AS conf FROM playbooks')
        .get() as { n: number; uses: number; conf: number };
      return { playbooks: r.n, totalUses: r.uses, avgConfidence: Math.round(r.conf * 100) / 100 };
    } catch {
      return { playbooks: 0, totalUses: 0, avgConfidence: 0 };
    }
  }
}
