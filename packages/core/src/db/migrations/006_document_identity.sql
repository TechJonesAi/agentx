-- P7-1: Unified Per-Document Identity
-- Adds source_type for category-aware storage and parent_document_id for attachment linkage

-- Source type: distinguishes document categories beyond origin_type
-- Values: pdf, text, image, screenshot, email, attachment, transcript, ocr, other
ALTER TABLE documents ADD COLUMN source_type TEXT NOT NULL DEFAULT 'other';

-- Parent document ID: links attachments/derivatives to their parent document
ALTER TABLE documents ADD COLUMN parent_document_id TEXT REFERENCES documents(document_id) ON DELETE SET NULL;

-- Index for efficient queries by source_type and parent linkage
CREATE INDEX IF NOT EXISTS idx_documents_source_type ON documents(source_type);
CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_document_id);

