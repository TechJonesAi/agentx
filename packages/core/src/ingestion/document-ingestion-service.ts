import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';
import { DocumentRegistry } from '../memory/document-registry.js';
import { generateId } from '../memory/id-generator.js';
import type { DocumentMetadata, DocumentPage, DocumentChunk, ClassificationLabel } from '../memory/types.js';
import { TextExtractorFactory } from './text-extractors.js';
import { DocumentClassifier } from '../classification/document-classifier.js';
import { EntityExtractor } from '../entities/entity-extractor.js';
import { EntityIndexService } from '../entities/entity-index-service.js';
import { EntityIngestionService } from '../entities/entity-ingestion-service.js';
import { FtsIndexService } from '../memory/fts-index-service.js';
import { createHash } from 'node:crypto';

const log = createLogger('ingestion:service');

export interface IngestionConfig {
  maxFileSizeBytes: number;
  enableOCR: boolean;
  /** R5.5: gate entity-index population. Default false — preserves prior
   *  behaviour where entity_mentions are not written from this path. */
  enableEntityIndexing?: boolean;
}

export interface IngestionResult {
  documentId: string;
  status: 'success' | 'failed' | 'partial';
  error?: string;
  metadata: DocumentMetadata;
  pageCount: number;
  chunkCount: number;
  entityCount: number;
}

export class DocumentIngestionService {
  private db: Database.Database;
  private registry: DocumentRegistry;
  private classifier: DocumentClassifier;
  private entityExtractor: EntityExtractor;
  private entityIndex: EntityIndexService;
  private entityIngestion: EntityIngestionService;
  private ftsIndex: FtsIndexService;
  private extractorFactory: TextExtractorFactory;
  private config: IngestionConfig;

  constructor(
    db: Database.Database,
    config: IngestionConfig = { maxFileSizeBytes: 100 * 1024 * 1024, enableOCR: false },
  ) {
    this.db = db;
    this.registry = new DocumentRegistry(db);
    this.classifier = new DocumentClassifier();
    this.entityExtractor = new EntityExtractor();
    this.entityIndex = new EntityIndexService(db);
    this.entityIngestion = new EntityIngestionService(db, this.entityExtractor, this.entityIndex);
    this.ftsIndex = new FtsIndexService(db);
    this.extractorFactory = new TextExtractorFactory();
    this.config = config;
  }

  async ingest(
    filePath: string,
    fileName: string,
    mimeType: string,
    originType: string,
  ): Promise<IngestionResult> {
    const ingestionId = generateId('ingest');

    try {
      log.info({ filePath, fileName, mimeType }, 'Starting document ingestion');

      const fs = await import('node:fs/promises');
      const stats = await fs.stat(filePath);

      if (stats.size > this.config.maxFileSizeBytes) {
        throw new Error(`File size exceeds maximum: ${stats.size} > ${this.config.maxFileSizeBytes}`);
      }

      const fileBuffer = await fs.readFile(filePath);
      const contentHash = createHash('sha256').update(fileBuffer).digest('hex');

      const existing = this.registry.getByHash(contentHash);
      if (existing) {
        log.warn({ documentId: existing.document_id }, 'Document already ingested');
        return {
          documentId: existing.document_id,
          status: 'success',
          metadata: existing,
          pageCount: existing.page_count,
          chunkCount: existing.chunk_count,
          entityCount: 0,
        };
      }

      const extractor = this.extractorFactory.getExtractor(mimeType, fileName);
      if (!extractor) {
        throw new Error(`No extractor available for mime type: ${mimeType}`);
      }

      const extracted = await extractor.extract(filePath);

      const classification = await this.classifier.classify(
        fileName,
        extracted.fullText,
        mimeType,
      );

      const documentMetadata = this.registry.create({
        file_name: fileName,
        file_type: this.getFileType(mimeType),
        mime_type: mimeType,
        content_type: this.getContentType(mimeType),
        content_subtype: this.getContentSubtype(mimeType),
        origin_type: originType,
        title: fileName,
        page_count: extracted.metadata.totalPages,
        chunk_count: 0,
        ocr_required: extracted.metadata.ocrRequired && this.config.enableOCR,
        ocr_completed: false,
        classification_label: classification.label,
        classification_confidence: classification.confidence,
        classification_method: classification.method,
        extraction_status: 'extracting',
        indexing_status: 'pending',
        content_hash: contentHash,
      });

      return await this.db.transaction(() => {
        const pages = this.storePages(documentMetadata.document_id, extracted);
        const chunks = this.createChunks(documentMetadata.document_id, pages);

        this.storeChunks(chunks);
        this.registry.update(documentMetadata.document_id, {
          chunk_count: chunks.length,
          extraction_status: 'extracted',
        });

        const entities = this.extractAndIndexEntities(documentMetadata.document_id, extracted.fullText);
        this.ftsIndex.upsertDocumentFts(documentMetadata.document_id, {
          title: documentMetadata.title || '',
          sender: documentMetadata.sender || '',
          recipient: documentMetadata.recipient || '',
          subject: documentMetadata.subject || '',
          content: extracted.fullText,
          file_name: documentMetadata.file_name,
        });

        for (const chunk of chunks) {
          this.ftsIndex.upsertChunkFts(chunk.chunk_id, chunk.document_id, chunk.content);
        }

        const final = this.registry.update(documentMetadata.document_id, {
          indexing_status: 'indexed',
        });

        return {
          documentId: final.document_id,
          status: 'success' as const,
          metadata: final,
          pageCount: pages.length,
          chunkCount: chunks.length,
          entityCount: entities.length,
        };
      })();

    } catch (error) {
      log.error({ ingestionId, filePath, error }, 'Document ingestion failed');
      throw error;
    }
  }

  private storePages(documentId: string, extracted: any): DocumentPage[] {
    const pages: DocumentPage[] = [];
    const stmt = this.db.prepare(`
      INSERT INTO document_pages (page_id, document_id, page_number, content, raw_content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const page of extracted.pages) {
      const pageId = generateId('page');
      stmt.run(
        pageId,
        documentId,
        page.pageNumber,
        page.content,
        page.rawContent ?? null,
        Date.now(),
      );
      pages.push({
        page_id: pageId,
        document_id: documentId,
        page_number: page.pageNumber,
        content: page.content,
        raw_content: page.rawContent,
        created_at: Date.now(),
      });
    }

    return pages;
  }

  private createChunks(documentId: string, pages: DocumentPage[]): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const chunkSize = 1024;
    const overlapSize = 128;

    for (const page of pages) {
      let chunkNumber = 0;

      for (let i = 0; i < page.content.length; i += chunkSize - overlapSize) {
        const chunkContent = page.content.substring(i, i + chunkSize);
        const chunkId = generateId('chunk');

        chunks.push({
          chunk_id: chunkId,
          document_id: documentId,
          page_id: page.page_id,
          chunk_number: chunkNumber++,
          content: chunkContent,
          token_count: Math.ceil(chunkContent.split(/\s+/).length),
          created_at: Date.now(),
        });
      }
    }

    return chunks;
  }

  private storeChunks(chunks: DocumentChunk[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO document_chunks (
        chunk_id, document_id, page_id, chunk_number, content, token_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const chunk of chunks) {
      stmt.run(
        chunk.chunk_id,
        chunk.document_id,
        chunk.page_id ?? null,
        chunk.chunk_number,
        chunk.content,
        chunk.token_count,
        chunk.created_at,
      );
    }
  }

  /**
   * R5.5: gated entity ingestion path. Delegates to EntityIngestionService
   * which (a) deletes stale mentions for the document first so re-ingestion
   * is idempotent, and (b) writes mentions with the STORED entity_id from
   * upsertEntity (the prior implementation used the freshly-generated
   * extractor id which dangled when the canonical_form already existed).
   *
   * When `config.enableEntityIndexing` is falsy, this is a no-op — no
   * entities or mentions are written.
   */
  private extractAndIndexEntities(documentId: string, text: string): unknown[] {
    if (!this.config.enableEntityIndexing) return [];
    const result = this.entityIngestion.ingestDocument(documentId, text);
    // Return an array of length=mentionsCreated for callers that read
    // `entityCount` from `IngestionResult.entityCount = entities.length`.
    return new Array(result.mentionsCreated).fill(null);
  }

  private getFileType(mimeType: string): string {
    const typeMap: Record<string, string> = {
      'application/pdf': 'pdf',
      'text/plain': 'txt',
      'text/email': 'email',
      'message/rfc822': 'email',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    };
    return typeMap[mimeType] || 'unknown';
  }

  private getContentType(mimeType: string): string {
    if (mimeType.startsWith('text/')) return 'text';
    if (mimeType.startsWith('application/')) return 'document';
    if (mimeType.startsWith('image/')) return 'image';
    return 'unknown';
  }

  private getContentSubtype(mimeType: string): string {
    return mimeType.split('/')[1] || 'unknown';
  }
}
