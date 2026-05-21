-- Batch 6A — durable workflow / autonomous-loop runtime.
-- Records every workflow/loop start, every phase transition, retries,
-- failures, repair attempts, and approval state so the engine can
-- resume work after server restart.

CREATE TABLE IF NOT EXISTS workflow_runs (
  loop_id           TEXT PRIMARY KEY,
  parent_loop_id    TEXT,
  goal              TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'running',
                    -- running | paused | awaiting_approval | succeeded | failed | interrupted_by_restart
  execution_phase   TEXT,
                    -- planning | executing | reflecting | repairing | (custom)
  retry_count       INTEGER NOT NULL DEFAULT 0,
  failure_reason    TEXT,
  repair_action     TEXT,
  approval_required INTEGER NOT NULL DEFAULT 0,    -- 0|1
  resumed_from_state TEXT,
  result_summary    TEXT,
  metadata_json     TEXT,                          -- arbitrary JSON
  started_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  completed_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_state  ON workflow_runs (state);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent ON workflow_runs (parent_loop_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_started ON workflow_runs (started_at DESC);

-- Per-event timeline. Each row is one structured event in a workflow's life.
CREATE TABLE IF NOT EXISTS workflow_events (
  event_id       TEXT PRIMARY KEY,
  loop_id        TEXT NOT NULL,
  event_kind     TEXT NOT NULL,
                  -- start | phase_change | retry | failure | repair_attempt
                  -- | repair_outcome | pause | resume | approval_request
                  -- | approval_granted | approval_rejected | success
                  -- | interrupted_by_restart | recovered_after_restart
  detail         TEXT,                              -- free-text or JSON blob
  ts             INTEGER NOT NULL,
  FOREIGN KEY (loop_id) REFERENCES workflow_runs(loop_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_loop ON workflow_events (loop_id, ts);
CREATE INDEX IF NOT EXISTS idx_workflow_events_ts   ON workflow_events (ts DESC);
