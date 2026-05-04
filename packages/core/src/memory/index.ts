export { createDatabase } from './database.js';
export { ConversationMemory } from './conversation.js';
export { LongTermMemoryStore } from './longterm.js';

// Cognitive Memory System exports
export { CognitiveMemorySystem } from './cognitive-memory-system.js';
export { DocumentRegistry } from './document-registry.js';
export { DocumentChunker } from './chunker.js';
export { FtsIndexService } from './fts-index-service.js';
export { LearningService } from './learning-service.js';

export type {
  DocumentMetadata,
  DocumentPage,
  DocumentChunk,
  Entity,
  EntityMention,
  RetrievalResult,
  RetrievalLog
} from './types.js';
