-- Learning Signals Schema v1.0
-- Standalone learning signal storage for reinforcement hooks.
-- Does NOT modify existing tables.

-- Learning signals: standalone feedback records
-- Decoupled from retrieval_logs to support direct user feedback.
CREATE TABLE IF NOT EXISTS learning_signals (
  signal_id TEXT PRIMARY KEY,
  signal_type TEXT NOT NULL CHECK (signal_type IN (
    'document_selection',
    'entity_selection',
    'positive_feedback',
    'negative_feedback',
    'correction'
  )),
  document_id TEXT,
  entity_id TEXT,
  user_id TEXT NOT NULL DEFAULT 'system',
  reason TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES entities(entity_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_learning_signals_type ON learning_signals(signal_type);
CREATE INDEX IF NOT EXISTS idx_learning_signals_document_id ON learning_signals(document_id);
CREATE INDEX IF NOT EXISTS idx_learning_signals_entity_id ON learning_signals(entity_id);
CREATE INDEX IF NOT EXISTS idx_learning_signals_created_at ON learning_signals(created_at);

