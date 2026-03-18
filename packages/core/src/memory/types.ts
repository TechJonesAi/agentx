export interface DocumentMetadata {
  document_id: string;
  file_name: string;
  file_type: string;
  mime_type: string;
  content_type: string;
  content_subtype?: string;
  origin_type: string;
  title?: string;
  sender?: string;
  sender_email?: string;
  recipient?: string;
  recipient_email?: string;
  subject?: string;
  document_date?: number;
  page_count: number;
  chunk_count: number;
  ocr_required: boolean;
  ocr_completed: boolean;
  classification_label?: string;
  classification_confidence: number;
  classification_method?: string;
  extraction_status: string;
  indexing_status: string;
  content_hash: string;
  ingested_at: number;
  updated_at: number;
}

export interface DocumentPage {
  page_id: string;
  document_id: string;
  page_number: number;
  content: string;
  raw_content?: string;
  page_hash?: string;
  ocr_confidence?: number;
  created_at: number;
}

export interface DocumentChunk {
  chunk_id: string;
  document_id: string;
  page_id?: string;
  chunk_number: number;
  content: string;
  token_count: number;
  embedding_id?: string;
  chunk_hash?: string;
  created_at: number;
}

export interface Entity {
  entity_id: string;
  canonical_form: string;
  entity_type: string;
  normalized_form: string;
  first_seen: number;
  last_seen: number;
  mention_count: number;
  metadata?: Record<string, unknown>;
  created_at: number;
}

export interface EntityMention {
  mention_id: string;
  entity_id: string;
  document_id: string;
  page_id?: string;
  chunk_id?: string;
  position_start?: number;
  position_end?: number;
  context_before?: string;
  context_after?: string;
  mention_text: string;
  confidence: number;
  created_at: number;
}

export interface RetrievalResult {
  result_id: string;
  log_id: string;
  document_id: string;
  chunk_id?: string;
  rank: number;
  score: number;
  score_type: string;
  matched_field?: string;
  document?: DocumentMetadata;
  chunk?: DocumentChunk;
  created_at: number;
}

export interface RetrievalLog {
  log_id: string;
  query_text: string;
  query_intent: string;
  user_id?: string;
  session_id?: string;
  result_count: number;
  execution_ms: number;
  ranked_correctly: boolean;
  feedback_provided: boolean;
  created_at: number;
}

export interface UserFeedbackMemory {
  feedback_id: string;
  log_id: string;
  result_id?: string;
  document_id: string;
  feedback_type: string;
  feedback_value: number;
  notes?: string;
  created_at: number;
}

export interface LearnedBoost {
  boost_id: string;
  document_id: string;
  entity_id?: string;
  boost_type: string;
  boost_multiplier: number;
  frequency_used: number;
  avg_feedback_score: number;
  confidence: number;
  created_at: number;
  updated_at: number;
}

export type ClassificationLabel =
  | 'email'
  | 'report'
  | 'legal_doc'
  | 'letter'
  | 'transcript'
  | 'policy'
  | 'note'
  | 'scan'
  | 'unknown';

export type EntityType =
  | 'person'
  | 'organisation'
  | 'email'
  | 'date'
  | 'case_reference'
  | 'term';

export type QueryIntent =
  | 'COUNT'
  | 'EXACT_SEARCH'
  | 'FILTERED_SEARCH'
  | 'SEMANTIC'
  | 'ANALYTICAL';

export interface IngestConfig {
  supportedMimeTypes: string[];
  maxFileSizeBytes: number;
  enableOCR: boolean;
  ocrConfidenceThreshold: number;
}
