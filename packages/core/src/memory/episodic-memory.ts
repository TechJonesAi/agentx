/**
 * Episodic Memory — Causal containers for related memory events
 *
 * Every agent loop creates an episode. Steps are added during execution
 * (observation → reasoning → action → outcome). Memories are linked to
 * episodes, enabling causal chain retrieval and outcome-based reinforcement.
 *
 * SQLite-backed via the cognitive memory database.
 */

import { createLogger } from '../logger.js';
import type { SqliteMemoryDb } from '../db/sqlite-memory.js';

const log = createLogger('memory:episodic');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EpisodeStatus = 'active' | 'closed' | 'consolidated';
export type StepType = 'observation' | 'reasoning' | 'action' | 'outcome';

export interface EpisodeStep {
  id: string;
  episodeId: string;
  memoryId?: string;
  eventType: StepType;
  content: string;
  timestamp: number;
  causalParentId?: string;
}

export interface Episode {
  id: string;
  sessionId: string;
  projectId?: string;
  title: string;
  status: EpisodeStatus;
  startedAt: number;
  closedAt?: number;
  outcomeScore?: number;
  outcomeSummary?: string;
  tags: string[];
  steps: EpisodeStep[];
  linkedMemoryIds: string[];
}

export interface EpisodeDiagnostics {
  totalEpisodes: number;
  activeEpisodes: number;
  closedEpisodes: number;
  totalEvents: number;
  avgStepsPerEpisode: number;
  avgOutcomeScore: number;
  health: 'healthy' | 'cold-start';
}

// ---------------------------------------------------------------------------
// Schema (inline fallback if migration hasn't run)
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT,
  title TEXT NOT NULL DEFAULT 'Untitled Episode',
  status TEXT NOT NULL DEFAULT 'active',
  started_at INTEGER NOT NULL,
  closed_at INTEGER,
  outcome_score REAL,
  outcome_summary TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ep_session ON episodes(session_id);
CREATE INDEX IF NOT EXISTS idx_ep_status ON episodes(status);
CREATE INDEX IF NOT EXISTS idx_ep_started ON episodes(started_at DESC);

CREATE TABLE IF NOT EXISTS episode_events (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  memory_id TEXT,
  event_type TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  causal_parent_id TEXT,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ee_episode ON episode_events(episode_id);
CREATE INDEX IF NOT EXISTS idx_ee_memory ON episode_events(memory_id);
`;

// ---------------------------------------------------------------------------
// EpisodeStore
// ---------------------------------------------------------------------------

let idCounter = 0;
function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++idCounter}`;
}

export class EpisodeStore {
  private db: SqliteMemoryDb;

  constructor(db: SqliteMemoryDb) {
    this.db = db;
    this.ensureSchema();
    log.info('Episode store initialized');
  }

  private ensureSchema(): void {
    try {
      this.db.exec(SCHEMA_SQL);
    } catch {
      // Tables may already exist
    }
  }

  createEpisode(sessionId: string, projectId?: string, title?: string): Episode {
    const id = genId('ep');
    const now = Date.now();

    this.db.prepare<unknown[]>(
      `INSERT INTO episodes (id, session_id, project_id, title, status, started_at, tags_json)
       VALUES (?, ?, ?, ?, 'active', ?, '[]')`
    ).run(id, sessionId, projectId ?? null, title ?? 'Untitled Episode', now);

    log.info({ episodeId: id, sessionId }, 'Episode created');

    return {
      id, sessionId, projectId, title: title ?? 'Untitled Episode',
      status: 'active', startedAt: now, tags: [], steps: [], linkedMemoryIds: [],
    };
  }

  addStep(episodeId: string, eventType: StepType, content: string, linkedMemoryId?: string, causalParentId?: string): EpisodeStep {
    const id = genId('ev');
    const now = Date.now();

    this.db.prepare<unknown[]>(
      `INSERT INTO episode_events (id, episode_id, memory_id, event_type, content, timestamp, causal_parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, episodeId, linkedMemoryId ?? null, eventType, content, now, causalParentId ?? null);

    return { id, episodeId, memoryId: linkedMemoryId, eventType, content, timestamp: now, causalParentId };
  }

  linkMemory(episodeId: string, memoryId: string): void {
    // Add a link event without specific content
    this.addStep(episodeId, 'observation', `Linked memory: ${memoryId}`, memoryId);
  }

  closeEpisode(episodeId: string, outcomeScore?: number, outcomeSummary?: string): void {
    const now = Date.now();

    this.db.prepare<unknown[]>(
      `UPDATE episodes SET status = 'closed', closed_at = ?, outcome_score = ?, outcome_summary = ? WHERE id = ?`
    ).run(now, outcomeScore ?? null, outcomeSummary ?? null, episodeId);

    // Record outcome as final step
    if (outcomeSummary) {
      this.addStep(episodeId, 'outcome', outcomeSummary);
    }

    log.info({ episodeId, outcomeScore }, 'Episode closed');
  }

  getEpisode(id: string): Episode | null {
    const row = this.db.prepare(
      `SELECT * FROM episodes WHERE id = ?`
    ).get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    const steps = this.getSteps(id);
    const linkedMemoryIds = this.getLinkedMemoryIds(id);

    return this.rowToEpisode(row, steps, linkedMemoryIds);
  }

  getEpisodeChain(episodeId: string): EpisodeStep[] {
    const rows = this.db.prepare(
      `SELECT * FROM episode_events WHERE episode_id = ? ORDER BY timestamp ASC`
    ).all(episodeId) as Record<string, unknown>[];

    return rows.map(r => this.rowToStep(r));
  }

  getRecentEpisodes(limit = 20): Episode[] {
    const rows = this.db.prepare(
      `SELECT * FROM episodes ORDER BY started_at DESC LIMIT ?`
    ).all(limit) as Record<string, unknown>[];

    return rows.map(row => {
      const id = String(row.id);
      return this.rowToEpisode(row, this.getSteps(id), this.getLinkedMemoryIds(id));
    });
  }

  getEpisodesBySession(sessionId: string): Episode[] {
    const rows = this.db.prepare(
      `SELECT * FROM episodes WHERE session_id = ? ORDER BY started_at DESC`
    ).all(sessionId) as Record<string, unknown>[];

    return rows.map(row => {
      const id = String(row.id);
      return this.rowToEpisode(row, this.getSteps(id), this.getLinkedMemoryIds(id));
    });
  }

  getEpisodesForMemory(memoryId: string): Episode[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT e.* FROM episodes e
       JOIN episode_events ee ON e.id = ee.episode_id
       WHERE ee.memory_id = ?
       ORDER BY e.started_at DESC`
    ).all(memoryId) as Record<string, unknown>[];

    return rows.map(row => {
      const id = String(row.id);
      return this.rowToEpisode(row, this.getSteps(id), this.getLinkedMemoryIds(id));
    });
  }

  getActiveEpisode(sessionId: string): Episode | null {
    const row = this.db.prepare(
      `SELECT * FROM episodes WHERE session_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`
    ).get(sessionId) as Record<string, unknown> | undefined;

    if (!row) return null;

    const id = String(row.id);
    return this.rowToEpisode(row, this.getSteps(id), this.getLinkedMemoryIds(id));
  }

  getDiagnostics(): EpisodeDiagnostics {
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM episodes`
    ).get() as Record<string, unknown> | undefined;

    const activeRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM episodes WHERE status = 'active'`
    ).get() as Record<string, unknown> | undefined;

    const closedRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM episodes WHERE status = 'closed'`
    ).get() as Record<string, unknown> | undefined;

    const eventsRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM episode_events`
    ).get() as Record<string, unknown> | undefined;

    const avgRow = this.db.prepare(
      `SELECT AVG(outcome_score) as avg_score FROM episodes WHERE outcome_score IS NOT NULL`
    ).get() as Record<string, unknown> | undefined;

    const total = Number(totalRow?.cnt ?? 0);
    const events = Number(eventsRow?.cnt ?? 0);

    return {
      totalEpisodes: total,
      activeEpisodes: Number(activeRow?.cnt ?? 0),
      closedEpisodes: Number(closedRow?.cnt ?? 0),
      totalEvents: events,
      avgStepsPerEpisode: total > 0 ? events / total : 0,
      avgOutcomeScore: Number(avgRow?.avg_score ?? 0),
      health: total > 0 ? 'healthy' : 'cold-start',
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private getSteps(episodeId: string): EpisodeStep[] {
    const rows = this.db.prepare(
      `SELECT * FROM episode_events WHERE episode_id = ? ORDER BY timestamp ASC`
    ).all(episodeId) as Record<string, unknown>[];
    return rows.map(r => this.rowToStep(r));
  }

  private getLinkedMemoryIds(episodeId: string): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT memory_id FROM episode_events WHERE episode_id = ? AND memory_id IS NOT NULL`
    ).all(episodeId) as Record<string, unknown>[];
    return rows.map(r => String(r.memory_id));
  }

  private rowToEpisode(row: Record<string, unknown>, steps: EpisodeStep[], linkedMemoryIds: string[]): Episode {
    let tags: string[] = [];
    try { tags = JSON.parse(String(row.tags_json || '[]')); } catch { tags = []; }

    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      projectId: row.project_id ? String(row.project_id) : undefined,
      title: String(row.title),
      status: String(row.status) as EpisodeStatus,
      startedAt: Number(row.started_at),
      closedAt: row.closed_at ? Number(row.closed_at) : undefined,
      outcomeScore: row.outcome_score !== null ? Number(row.outcome_score) : undefined,
      outcomeSummary: row.outcome_summary ? String(row.outcome_summary) : undefined,
      tags,
      steps,
      linkedMemoryIds,
    };
  }

  private rowToStep(row: Record<string, unknown>): EpisodeStep {
    return {
      id: String(row.id),
      episodeId: String(row.episode_id),
      memoryId: row.memory_id ? String(row.memory_id) : undefined,
      eventType: String(row.event_type) as StepType,
      content: String(row.content),
      timestamp: Number(row.timestamp),
      causalParentId: row.causal_parent_id ? String(row.causal_parent_id) : undefined,
    };
  }
}
