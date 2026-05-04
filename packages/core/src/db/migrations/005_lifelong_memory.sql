-- Migration 005: Lifelong Memory Core
-- Adds episodic memory, importance scoring, and cross-session knowledge flow

-- Episodes table — causal containers for related memory events
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT,
  title TEXT NOT NULL DEFAULT 'Untitled Episode',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'consolidated')),
  started_at INTEGER NOT NULL,
  closed_at INTEGER,
  outcome_score REAL,
  outcome_summary TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_ep_session ON episodes(session_id);
CREATE INDEX IF NOT EXISTS idx_ep_project ON episodes(project_id);
CREATE INDEX IF NOT EXISTS idx_ep_status ON episodes(status);
CREATE INDEX IF NOT EXISTS idx_ep_started ON episodes(started_at DESC);

-- Episode events — steps within an episode (observation → reasoning → action → outcome)
CREATE TABLE IF NOT EXISTS episode_events (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  memory_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('observation', 'reasoning', 'action', 'outcome')),
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  causal_parent_id TEXT,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ee_episode ON episode_events(episode_id);
CREATE INDEX IF NOT EXISTS idx_ee_memory ON episode_events(memory_id);
CREATE INDEX IF NOT EXISTS idx_ee_type ON episode_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ee_causal ON episode_events(causal_parent_id);

