-- Batch 9 — Provider benchmark history.
-- Records per-task-category, per-provider, per-model benchmark scores so
-- the routing engine can demote/promote based on EVIDENCE, not guesses.

CREATE TABLE IF NOT EXISTS provider_benchmarks (
  benchmark_id      TEXT PRIMARY KEY,
  ranAt             INTEGER NOT NULL,
  task_category     TEXT NOT NULL,
                    -- chat | coding | reasoning | retrieval-grounded-qa
                    -- | summarisation | tool-calling | builder
                    -- | long-context | json-formatting | (custom)
  provider          TEXT NOT NULL,        -- ollama | omlx | ...
  model             TEXT NOT NULL,
  -- raw measurements
  ttftMs            INTEGER,              -- time-to-first-token (ms)
  totalLatencyMs    INTEGER,
  tokensPerSec      REAL,
  -- task-quality measurements (0..1 or boolean)
  jsonValid         INTEGER,              -- 0|1|null
  toolCallValid     INTEGER,              -- 0|1|null
  groundedScore     REAL,                 -- 0..1 or null
  retryCount        INTEGER NOT NULL DEFAULT 0,
  failureReason     TEXT,
  -- composite score (0..1) — set by the harness, used by router
  score             REAL NOT NULL,
  notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_pb_taskcat   ON provider_benchmarks (task_category);
CREATE INDEX IF NOT EXISTS idx_pb_provider  ON provider_benchmarks (provider);
CREATE INDEX IF NOT EXISTS idx_pb_ranAt     ON provider_benchmarks (ranAt DESC);
