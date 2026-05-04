-- Migration 007: Replace external-content FTS with contentless FTS.
--
-- The existing documents_fts/chunks_fts use `content=documents`/`content=document_chunks`
-- (external content), but the documents table has no `content` column — making any
-- read-back of FTS rows fail with "no such column: T.content".
--
-- This migration drops the broken triggers, drops the broken FTS tables, and
-- recreates them as contentless FTS5 — values stored only in the FTS index, no
-- back-reference to the source table. The new triggers populate FTS directly.

DROP TRIGGER IF EXISTS documents_fts_insert;
DROP TRIGGER IF EXISTS documents_fts_delete;
DROP TRIGGER IF EXISTS chunks_fts_insert;
DROP TRIGGER IF EXISTS chunks_fts_delete;

DROP TABLE IF EXISTS documents_fts;
DROP TABLE IF EXISTS chunks_fts;

CREATE VIRTUAL TABLE documents_fts USING fts5(
  document_id UNINDEXED,
  title,
  sender,
  recipient,
  subject,
  content,
  file_name,
  content=''
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  content,
  content=''
);

CREATE TRIGGER documents_fts_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, document_id, title, sender, recipient, subject, content, file_name)
  VALUES (new.rowid, new.document_id, COALESCE(new.title, ''), COALESCE(new.sender, ''),
          COALESCE(new.recipient, ''), COALESCE(new.subject, ''), '', new.file_name);
END;

CREATE TRIGGER documents_fts_delete AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid) VALUES('delete', old.rowid);
END;

CREATE TRIGGER chunks_fts_insert AFTER INSERT ON document_chunks BEGIN
  INSERT INTO chunks_fts(rowid, chunk_id, document_id, content)
  VALUES (new.rowid, new.chunk_id, new.document_id, new.content);
END;

CREATE TRIGGER chunks_fts_delete AFTER DELETE ON document_chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid) VALUES('delete', old.rowid);
END;
