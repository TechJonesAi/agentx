import type { DocumentChunk } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('memory:vector-index');

export interface VectorEmbedding {
  chunk_id: string;
  document_id: string;
  vector: number[];
  metadata: {
    page_number?: number;
    chunk_number: number;
  };
}

export interface VectorSearchResult {
  chunk_id: string;
  document_id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export abstract class VectorIndexService {
  abstract initialize(): Promise<void>;
  abstract isInitialized(): boolean;
  abstract upsertEmbedding(embedding: VectorEmbedding): Promise<void>;
  abstract deleteEmbedding(chunkId: string): Promise<void>;
  abstract search(vector: number[], topK: number): Promise<VectorSearchResult[]>;
  abstract close(): Promise<void>;
}

export class LanceDbVectorService extends VectorIndexService {
  private db: any;
  private table: any;
  private initialized = false;

  constructor(private dataDir: string) { super(); }

  async initialize(): Promise<void> {
    try {
      // @ts-expect-error optional runtime dependency — not installed by default
      const lancedb = await import('lancedb');
      this.db = await lancedb.connect(this.dataDir);
      this.initialized = true;
      log.info('LanceDB vector index initialized');
    } catch (error) {
      log.error({ error }, 'Failed to initialize LanceDB');
      throw error;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async upsertEmbedding(embedding: VectorEmbedding): Promise<void> {
    if (!this.initialized) {
      throw new Error('Vector index not initialized');
    }

    try {
      if (!this.table) {
        this.table = await this.db.createTable('embeddings', [embedding], { mode: 'overwrite' });
      } else {
        await this.table.add([embedding]);
      }
      log.debug({ chunkId: embedding.chunk_id }, 'Embedding upserted');
    } catch (error) {
      log.error({ error }, 'Failed to upsert embedding');
      throw error;
    }
  }

  async deleteEmbedding(chunkId: string): Promise<void> {
    if (!this.initialized || !this.table) {
      return;
    }

    try {
      await this.table.delete(`chunk_id = '${chunkId}'`);
      log.debug({ chunkId }, 'Embedding deleted');
    } catch (error) {
      log.error({ error }, 'Failed to delete embedding');
    }
  }

  async search(vector: number[], topK: number = 10): Promise<VectorSearchResult[]> {
    if (!this.initialized || !this.table) {
      return [];
    }

    try {
      const results = await this.table.search(vector).limit(topK).toList();
      return results.map((result: any) => ({
        chunk_id: result.chunk_id,
        document_id: result.document_id,
        score: result._score,
        metadata: result.metadata,
      }));
    } catch (error) {
      log.error({ error }, 'Vector search failed');
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db = null;
      this.table = null;
      this.initialized = false;
      log.info('LanceDB vector index closed');
    }
  }
}

export class FaissVectorService extends VectorIndexService {
  private index: any;
  private idMap: Map<string, number> = new Map();
  private metadata: Map<number, VectorEmbedding> = new Map();
  private nextId = 0;
  private initialized = false;

  constructor(private dimension: number = 768) { super(); }

  async initialize(): Promise<void> {
    try {
      // @ts-expect-error optional runtime dependency — not installed by default
      const faiss = await import('faiss-node');
      this.index = new faiss.IndexFlatL2(this.dimension);
      this.initialized = true;
      log.info({ dimension: this.dimension }, 'FAISS vector index initialized');
    } catch (error) {
      log.error({ error }, 'Failed to initialize FAISS');
      throw error;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async upsertEmbedding(embedding: VectorEmbedding): Promise<void> {
    if (!this.initialized) {
      throw new Error('Vector index not initialized');
    }

    try {
      const id = this.nextId++;
      this.idMap.set(embedding.chunk_id, id);
      this.metadata.set(id, embedding);
      this.index.add([embedding.vector]);
      log.debug({ chunkId: embedding.chunk_id }, 'Embedding upserted in FAISS');
    } catch (error) {
      log.error({ error }, 'Failed to upsert embedding in FAISS');
      throw error;
    }
  }

  async deleteEmbedding(chunkId: string): Promise<void> {
    if (!this.initialized) {
      return;
    }

    const id = this.idMap.get(chunkId);
    if (id !== undefined) {
      this.idMap.delete(chunkId);
      this.metadata.delete(id);
      log.debug({ chunkId }, 'Embedding deleted from FAISS');
    }
  }

  async search(vector: number[], topK: number = 10): Promise<VectorSearchResult[]> {
    if (!this.initialized) {
      return [];
    }

    try {
      const distances = this.index.search([vector], topK);
      const results: VectorSearchResult[] = [];

      for (let i = 0; i < distances[0].length; i++) {
        const id = distances[1][i];
        const embedding = this.metadata.get(id);
        if (embedding) {
          results.push({
            chunk_id: embedding.chunk_id,
            document_id: embedding.document_id,
            score: 1 / (1 + distances[0][i]),
            metadata: embedding.metadata,
          });
        }
      }

      return results;
    } catch (error) {
      log.error({ error }, 'Vector search failed in FAISS');
      return [];
    }
  }

  async close(): Promise<void> {
    this.index = null;
    this.idMap.clear();
    this.metadata.clear();
    this.initialized = false;
    log.info('FAISS vector index closed');
  }
}

export class NoOpVectorService extends VectorIndexService {
  async initialize(): Promise<void> {
    log.info('Vector index disabled (NoOp)');
  }

  isInitialized(): boolean {
    return false;
  }

  async upsertEmbedding(): Promise<void> {
  }

  async deleteEmbedding(): Promise<void> {
  }

  async search(): Promise<VectorSearchResult[]> {
    return [];
  }

  async close(): Promise<void> {
  }
}
