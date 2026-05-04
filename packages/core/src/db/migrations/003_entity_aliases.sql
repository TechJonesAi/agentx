-- Entity Aliases Schema v1.0
-- Maps entity name variants to canonical entities.
-- Does NOT modify existing tables.

CREATE TABLE IF NOT EXISTS entity_aliases (
  alias_id TEXT PRIMARY KEY,
  canonical_entity_id TEXT NOT NULL,
  alias_name TEXT NOT NULL,
  alias_type TEXT NOT NULL CHECK (alias_type IN (
    'short_name',      -- e.g. "Rob" → "Robert Moyes"
    'full_name',       -- e.g. "Robert Moyes" → canonical
    'org_variant',     -- e.g. "Virgin Media Ltd" → "Virgin Media"
    'header_variant',  -- extracted from email headers/filenames
    'manual'           -- user-defined alias
  )),
  confidence REAL NOT NULL DEFAULT 1.0,  -- 0.0-1.0
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (canonical_entity_id) REFERENCES entities(entity_id) ON DELETE CASCADE,
  UNIQUE(alias_name, canonical_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_canonical ON entity_aliases(canonical_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_aliases_name ON entity_aliases(alias_name);

