import { createLogger } from '../logger.js';
import { generateId } from './id-generator.js';
import type { DocumentChunk, DocumentPage } from './types.js';

const log = createLogger('memory:chunker');

export interface ChunkingConfig {
  chunkSize: number;
  overlapSize: number;
  minChunkSize: number;
}

const DEFAULT_CONFIG: ChunkingConfig = {
  chunkSize: 1024,
  overlapSize: 128,
  minChunkSize: 200,
};

export class DocumentChunker {
  private config: ChunkingConfig;

  constructor(config: Partial<ChunkingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  createChunks(documentId: string, pages: DocumentPage[]): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];

    for (const page of pages) {
      const pageChunks = this.chunkPageContent(documentId, page);
      chunks.push(...pageChunks);
    }

    return chunks;
  }

  private chunkPageContent(documentId: string, page: DocumentPage): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const content = page.content;
    const sentences = this.splitIntoSentences(content);

    let currentChunk = '';
    let chunkNumber = 0;

    for (const sentence of sentences) {
      const potentialChunk = currentChunk ? `${currentChunk} ${sentence}` : sentence;

      if (potentialChunk.length <= this.config.chunkSize) {
        currentChunk = potentialChunk;
      } else {
        if (currentChunk.length >= this.config.minChunkSize) {
          chunks.push(this.createChunk(documentId, page, chunkNumber++, currentChunk));
        }
        currentChunk = sentence;
      }
    }

    if (currentChunk.length >= this.config.minChunkSize) {
      chunks.push(this.createChunk(documentId, page, chunkNumber, currentChunk));
    }

    return chunks;
  }

  private createChunk(
    documentId: string,
    page: DocumentPage,
    chunkNumber: number,
    content: string,
  ): DocumentChunk {
    return {
      chunk_id: generateId('chunk'),
      document_id: documentId,
      page_id: page.page_id,
      chunk_number: chunkNumber,
      content,
      token_count: this.estimateTokens(content),
      created_at: Date.now(),
    };
  }

  private splitIntoSentences(text: string): string[] {
    return text.split(/(?<=[.!?])\s+/).filter(s => s.length > 0);
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.split(/\s+/).length * 1.3);
  }
}
