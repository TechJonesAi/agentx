-- Documents table: core metadata for all ingested documents
CREATE TABLE IF NOT EXISTS documents (
  document_id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content_subtype TEXT,
  origin_type TEXT NOT NULL,
  title TEXT,
  sender TEXT,
  sender_email TEXT,
  recipient TEXT,
  recipient_email TEXT,
  subject TEXT,
  document_date INTEGER,
  page_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  ocr_required INTEGER DEFAULT 0,
  ocr_completed INTEGER DEFAULT 0,
  classification_label TEXT,
  classification_confidence REAL DEFAULT 0.0,
  classification_method TEXT,
  extraction_status TEXT DEFAULT 'pending',
  indexing_status TEXT DEFAULT 'pending',
  content_hash TEXT UNIQUE,
  ingested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_origin_type ON documents(origin_type);
CREATE INDEX IF NOT EXISTS idx_documents_classification ON documents(classification_label);
CREATE INDEX IF NOT EXISTS idx_documents_sender ON documents(sender);
CREATE INDEX IF NOT EXISTS idx_documents_document_date ON documents(document_date);
CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);
CREATE INDEX IF NOT EXISTS idx_documents_ingested_at ON documents(ingested_at);

-- Document pages: preserve page structure for precise location tracking
CREATE TABLE IF NOT EXISTS document_pages (
  page_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  content TEXT NOT NULL,
  raw_content TEXT,
  page_hash TEXT,
  ocr_confidence REAL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE,
  UNIQUE(document_id, page_number)
);

CREATE INDEX IF NOT EXISTS idx_document_pages_document_id ON document_pages(document_id);
CREATE INDEX IF NOT EXISTS idx_document_pages_page_number ON document_pages(page_number);

-- Document chunks: for retrieval and embedding
CREATE TABLE IF NOT EXISTS document_chunks (
  chunk_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  page_id TEXT,
  chunk_number INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  embedding_id TEXT,
  chunk_hash TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES document_pages(page_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_page_id ON document_chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_id ON document_chunks(embedding_id);

-- Entities: normalized entity references across documents
CREATE TABLE IF NOT EXISTS entities (
  entity_id TEXT PRIMARY KEY,
  canonical_form TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  normalized_form TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  mention_count INTEGER DEFAULT 0,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entities_canonical_form ON entities(canonical_form);
CREATE INDEX IF NOT EXISTS idx_entities_entity_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_normalized_form ON entities(normalized_form);

-- Entity mentions: track where entities appear
CREATE TABLE IF NOT EXISTS entity_mentions (
  mention_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  page_id TEXT,
  chunk_id TEXT,
  position_start INTEGER,
  position_end INTEGER,
  context_before TEXT,
  context_after TEXT,
  mention_text TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (entity_id) REFERENCES entities(entity_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES document_pages(page_id) ON DELETE SET NULL,
  FOREIGN KEY (chunk_id) REFERENCES document_chunks(chunk_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity_id ON entity_mentions(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_document_id ON entity_mentions(document_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_page_id ON entity_mentions(page_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_chunk_id ON entity_mentions(chunk_id);

-- Full-text search virtual table for document content
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  document_id UNINDEXED,
  title,
  sender,
  recipient,
  subject,
  content,
  file_name,
  content=documents,
  content_rowid=rowid
);

CREATE TABLE IF NOT EXISTS documents_fts_sync (
  document_id TEXT PRIMARY KEY,
  last_synced INTEGER NOT NULL
);

-- Full-text search virtual table for chunk content
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  content,
  content=document_chunks,
  content_rowid=rowid
);

CREATE TABLE IF NOT EXISTS chunks_fts_sync (
  chunk_id TEXT PRIMARY KEY,
  last_synced INTEGER NOT NULL
);

-- Conversations: store multi-turn conversation context
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  user_id TEXT,
  session_id TEXT,
  title TEXT,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  message_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_start_time ON conversations(start_time);

-- Conversation messages: individual messages within conversations
CREATE TABLE IF NOT EXISTS conversation_messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_number INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  UNIQUE(conversation_id, message_number)
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_id ON conversation_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_role ON conversation_messages(role);

-- Retrieval logs: track what queries were made and results
CREATE TABLE IF NOT EXISTS retrieval_logs (
  log_id TEXT PRIMARY KEY,
  query_text TEXT NOT NULL,
  query_intent TEXT NOT NULL,
  user_id TEXT,
  session_id TEXT,
  result_count INTEGER DEFAULT 0,
  execution_ms INTEGER DEFAULT 0,
  ranked_correctly INTEGER DEFAULT 0,
  feedback_provided INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_logs_user_id ON retrieval_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_logs_session_id ON retrieval_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_logs_query_intent ON retrieval_logs(query_intent);
CREATE INDEX IF NOT EXISTS idx_retrieval_logs_created_at ON retrieval_logs(created_at);

-- Retrieval results: individual results from a retrieval
CREATE TABLE IF NOT EXISTS retrieval_results (
  result_id TEXT PRIMARY KEY,
  log_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  chunk_id TEXT,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  score_type TEXT NOT NULL,
  matched_field TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (log_id) REFERENCES retrieval_logs(log_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_id) REFERENCES document_chunks(chunk_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_results_log_id ON retrieval_results(log_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_results_document_id ON retrieval_results(document_id);

-- User feedback on retrieval results: improve ranking
CREATE TABLE IF NOT EXISTS user_feedback_memory (
  feedback_id TEXT PRIMARY KEY,
  log_id TEXT NOT NULL,
  result_id TEXT,
  document_id TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  feedback_value INTEGER NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (log_id) REFERENCES retrieval_logs(log_id) ON DELETE CASCADE,
  FOREIGN KEY (result_id) REFERENCES retrieval_results(result_id) ON DELETE SET NULL,
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_feedback_memory_document_id ON user_feedback_memory(document_id);
CREATE INDEX IF NOT EXISTS idx_user_feedback_memory_feedback_type ON user_feedback_memory(feedback_type);

-- Learning/reinforcement boosts: learned preferences from feedback
CREATE TABLE IF NOT EXISTS learned_boosts (
  boost_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  entity_id TEXT,
  boost_type TEXT NOT NULL,
  boost_multiplier REAL NOT NULL DEFAULT 1.0,
  frequency_used INTEGER DEFAULT 0,
  avg_feedback_score REAL DEFAULT 0.0,
  confidence REAL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES entities(entity_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_learned_boosts_document_id ON learned_boosts(document_id);
CREATE INDEX IF NOT EXISTS idx_learned_boosts_entity_id ON learned_boosts(entity_id);
CREATE INDEX IF NOT EXISTS idx_learned_boosts_boost_type ON learned_boosts(boost_type);

-- FTS triggers: keep FTS tables in sync with base tables
CREATE TRIGGER IF NOT EXISTS documents_fts_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, document_id, title, sender, recipient, subject, content, file_name)
  VALUES (new.rowid, new.document_id, new.title, new.sender, new.recipient, new.subject, '', new.file_name);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_delete AFTER DELETE ON documents BEGIN
  DELETE FROM documents_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON document_chunks BEGIN
  INSERT INTO chunks_fts(rowid, chunk_id, document_id, content)
  VALUES (new.rowid, new.chunk_id, new.document_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON document_chunks BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.rowid;
END;
