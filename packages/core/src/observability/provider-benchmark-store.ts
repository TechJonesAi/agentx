/**
 * ProviderBenchmarkStore — Batch 9 evidence-based provider routing.
 *
 * Records benchmark results comparing local providers (Ollama, oMLX, …)
 * on a per-task-category basis. The routing engine reads `compare()`
 * to decide whether a provider has earned promotion/demotion FOR THAT
 * CATEGORY based on recorded evidence.
 *
 * Hard rules (mirroring the prompt):
 *   - Ollama remains the default. Evidence demotes/promotes — never
 *     guesses or hidden cloud fallback.
 *   - User pins override compare() output (enforced by the routing
 *     engine, not this store).
 *   - Every comparison surfaces a human-readable reason — no opaque
 *     score "5 > 3" without context.
 */
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

export interface BenchmarkInput {
  taskCategory: string;
  provider: string;
  model: string;
  ttftMs?: number;
  totalLatencyMs?: number;
  tokensPerSec?: number;
  jsonValid?: boolean | null;
  toolCallValid?: boolean | null;
  groundedScore?: number | null;
  retryCount?: number;
  failureReason?: string;
  /** Composite 0..1 score the harness assigns. Higher is better. */
  score: number;
  notes?: string;
}

export interface BenchmarkRow extends BenchmarkInput {
  benchmarkId: string;
  ranAt: number;
}

export interface ProviderComparison {
  taskCategory: string;
  winner: string | null;          // provider name or null when no data
  reasons: string[];              // human-readable rationale
  perProvider: Array<{
    provider: string;
    samples: number;
    avgScore: number;
    avgLatencyMs: number | null;
    lastFailureReason?: string;
  }>;
}

export class ProviderBenchmarkStore {
  private db: Database.Database;
  private static singletonByDb = new WeakMap<Database.Database, ProviderBenchmarkStore>();

  static get(db: Database.Database): ProviderBenchmarkStore {
    let inst = ProviderBenchmarkStore.singletonByDb.get(db);
    if (!inst) { inst = new ProviderBenchmarkStore(db); ProviderBenchmarkStore.singletonByDb.set(db, inst); }
    return inst;
  }

  static __createForTest(db: Database.Database): ProviderBenchmarkStore {
    return new ProviderBenchmarkStore(db);
  }

  private constructor(db: Database.Database) { this.db = db; }

  record(b: BenchmarkInput): BenchmarkRow {
    const id = `bm-${Date.now()}-${uuid().slice(0, 8)}`;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO provider_benchmarks
        (benchmark_id, ranAt, task_category, provider, model,
         ttftMs, totalLatencyMs, tokensPerSec, jsonValid, toolCallValid,
         groundedScore, retryCount, failureReason, score, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, now, b.taskCategory, b.provider, b.model,
      b.ttftMs ?? null, b.totalLatencyMs ?? null, b.tokensPerSec ?? null,
      b.jsonValid === undefined ? null : (b.jsonValid ? 1 : 0),
      b.toolCallValid === undefined ? null : (b.toolCallValid ? 1 : 0),
      b.groundedScore ?? null, b.retryCount ?? 0, b.failureReason ?? null,
      b.score, b.notes ?? null,
    );
    return { ...b, benchmarkId: id, ranAt: now };
  }

  recent(limit = 100, taskCategory?: string, provider?: string): BenchmarkRow[] {
    const n = Math.max(1, Math.min(500, limit));
    let sql = `SELECT * FROM provider_benchmarks`;
    const conds: string[] = [];
    const params: unknown[] = [];
    if (taskCategory) { conds.push(`task_category = ?`); params.push(taskCategory); }
    if (provider) { conds.push(`provider = ?`); params.push(provider); }
    if (conds.length > 0) sql += ` WHERE ${conds.join(' AND ')}`;
    sql += ` ORDER BY ranAt DESC LIMIT ?`;
    params.push(n);
    const rows = this.db.prepare(sql).all(...params) as Array<BenchmarkRowSql>;
    return rows.map(rowToBenchmark);
  }

  /** Compare providers for one task category. Reads up to `window` most
   *  recent samples per provider. Picks winner by average score with
   *  tiebreaker on average latency (lower wins). Surfaces reasons. */
  compare(taskCategory: string, opts: { window?: number; minSamples?: number } = {}): ProviderComparison {
    const window = Math.max(1, Math.min(500, opts.window ?? 20));
    const minSamples = Math.max(1, opts.minSamples ?? 3);
    const providers = this.db.prepare(`SELECT DISTINCT provider FROM provider_benchmarks WHERE task_category = ?`).all(taskCategory) as Array<{ provider: string }>;

    const perProvider: ProviderComparison['perProvider'] = [];
    for (const { provider } of providers) {
      const rows = this.db.prepare(`
        SELECT * FROM provider_benchmarks
        WHERE task_category = ? AND provider = ?
        ORDER BY ranAt DESC LIMIT ?
      `).all(taskCategory, provider, window) as Array<BenchmarkRowSql>;
      if (rows.length === 0) continue;
      const avgScore = rows.reduce((s, r) => s + r.score, 0) / rows.length;
      const latencies = rows.filter((r) => r.totalLatencyMs !== null).map((r) => r.totalLatencyMs as number);
      const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length) : null;
      const lastFailure = rows.find((r) => !!r.failureReason);
      perProvider.push({
        provider,
        samples: rows.length,
        avgScore: Math.round(avgScore * 1000) / 1000,
        avgLatencyMs,
        ...(lastFailure?.failureReason ? { lastFailureReason: lastFailure.failureReason } : {}),
      });
    }

    if (perProvider.length === 0) {
      return { taskCategory, winner: null, reasons: ['no benchmark samples'], perProvider: [] };
    }

    // Require at least one provider with enough samples to be a winner.
    const eligible = perProvider.filter((p) => p.samples >= minSamples);
    if (eligible.length === 0) {
      return {
        taskCategory,
        winner: null,
        reasons: [`no provider has >= ${minSamples} samples`],
        perProvider,
      };
    }

    // Highest avgScore wins; ties broken by lower avgLatencyMs.
    eligible.sort((a, b) => {
      if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
      const al = a.avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
      const bl = b.avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
      return al - bl;
    });
    const winner = eligible[0]!;
    const runnerUp = eligible[1];

    const reasons: string[] = [
      `${winner.provider} highest avg score ${winner.avgScore.toFixed(3)} over ${winner.samples} sample(s)`,
    ];
    if (runnerUp) {
      const scoreDelta = winner.avgScore - runnerUp.avgScore;
      reasons.push(`${runnerUp.provider} runner-up at ${runnerUp.avgScore.toFixed(3)} (Δ ${scoreDelta.toFixed(3)})`);
      if (winner.avgLatencyMs !== null && runnerUp.avgLatencyMs !== null) {
        if (winner.avgLatencyMs < runnerUp.avgLatencyMs) {
          reasons.push(`${winner.provider} also faster: ${winner.avgLatencyMs}ms vs ${runnerUp.avgLatencyMs}ms avg`);
        }
      }
    }
    if (winner.lastFailureReason) {
      reasons.push(`(${winner.provider} most-recent failure: ${winner.lastFailureReason})`);
    }

    return { taskCategory, winner: winner.provider, reasons, perProvider };
  }

  /** Distinct task categories with any data — feeds the dashboard. */
  taskCategories(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT task_category FROM provider_benchmarks ORDER BY task_category`).all() as Array<{ task_category: string }>;
    return rows.map((r) => r.task_category);
  }

  /** Total count (debug + dashboard "X benchmark runs recorded"). */
  size(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM provider_benchmarks`).get() as { n: number } | undefined;
    return r?.n ?? 0;
  }
}

interface BenchmarkRowSql {
  benchmark_id: string;
  ranAt: number;
  task_category: string;
  provider: string;
  model: string;
  ttftMs: number | null;
  totalLatencyMs: number | null;
  tokensPerSec: number | null;
  jsonValid: number | null;
  toolCallValid: number | null;
  groundedScore: number | null;
  retryCount: number;
  failureReason: string | null;
  score: number;
  notes: string | null;
}

function rowToBenchmark(r: BenchmarkRowSql): BenchmarkRow {
  return {
    benchmarkId: r.benchmark_id,
    ranAt: r.ranAt,
    taskCategory: r.task_category,
    provider: r.provider,
    model: r.model,
    ttftMs: r.ttftMs ?? undefined,
    totalLatencyMs: r.totalLatencyMs ?? undefined,
    tokensPerSec: r.tokensPerSec ?? undefined,
    jsonValid: r.jsonValid === null ? null : r.jsonValid === 1,
    toolCallValid: r.toolCallValid === null ? null : r.toolCallValid === 1,
    groundedScore: r.groundedScore,
    retryCount: r.retryCount,
    failureReason: r.failureReason ?? undefined,
    score: r.score,
    notes: r.notes ?? undefined,
  };
}
