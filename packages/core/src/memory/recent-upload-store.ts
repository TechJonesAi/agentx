/**
 * P6-21: Recent Upload Store — Memory Truth Layer
 *
 * Lightweight in-memory store tracking recently uploaded documents.
 * Provides the chat system with ground truth about what the user
 * has uploaded, their ingestion status, and enables recency boosting.
 *
 * This is NOT a persistent store — it's session-scoped and cleared on restart.
 * Its purpose is to bridge the gap between upload and retrieval visibility.
 */

import { createLogger } from '../logger.js';

const log = createLogger('memory:recent-upload-store');

export interface RecentUpload {
  documentId: string;
  fileName: string;
  timestamp: number;
  status: 'processing' | 'indexed' | 'failed';
  wordCount?: number;
  pageCount?: number;
  error?: string;
}

export class RecentUploadStore {
  /** In-memory map of recent uploads keyed by document_id */
  private uploads: Map<string, RecentUpload> = new Map();

  /** How long to consider an upload "recent" (default: 60 minutes) */
  private readonly recencyWindowMs: number;

  constructor(recencyWindowMinutes: number = 60) {
    this.recencyWindowMs = recencyWindowMinutes * 60 * 1000;
  }

  /**
   * Record a new upload. Called immediately when a document starts ingestion.
   */
  track(entry: {
    documentId: string;
    fileName: string;
    status?: 'processing' | 'indexed' | 'failed';
    wordCount?: number;
    pageCount?: number;
    error?: string;
  }): void {
    const upload: RecentUpload = {
      documentId: entry.documentId,
      fileName: entry.fileName,
      timestamp: Date.now(),
      status: entry.status ?? 'processing',
      wordCount: entry.wordCount,
      pageCount: entry.pageCount,
      error: entry.error,
    };
    this.uploads.set(entry.documentId, upload);
    log.info({ documentId: entry.documentId, fileName: entry.fileName, status: upload.status }, 'Tracked recent upload');
  }

  /**
   * Update status of an existing tracked upload.
   */
  updateStatus(documentId: string, status: 'processing' | 'indexed' | 'failed', extra?: { wordCount?: number; pageCount?: number; error?: string }): void {
    const existing = this.uploads.get(documentId);
    if (existing) {
      existing.status = status;
      if (extra?.wordCount !== undefined) existing.wordCount = extra.wordCount;
      if (extra?.pageCount !== undefined) existing.pageCount = extra.pageCount;
      if (extra?.error) existing.error = extra.error;
      log.info({ documentId, status }, 'Updated upload status');
    }
  }

  /**
   * Get all recent uploads (within recency window), sorted newest first.
   */
  getRecent(): RecentUpload[] {
    const cutoff = Date.now() - this.recencyWindowMs;
    const recent: RecentUpload[] = [];
    for (const upload of this.uploads.values()) {
      if (upload.timestamp >= cutoff) {
        recent.push(upload);
      }
    }
    return recent.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Check if a document_id is a recent upload.
   */
  isRecent(documentId: string): boolean {
    const upload = this.uploads.get(documentId);
    if (!upload) return false;
    return (Date.now() - upload.timestamp) < this.recencyWindowMs;
  }

  /**
   * Get the recency age in minutes for a document (for score boosting).
   * Returns null if not a recent upload.
   */
  getRecencyMinutes(documentId: string): number | null {
    const upload = this.uploads.get(documentId);
    if (!upload) return null;
    const ageMs = Date.now() - upload.timestamp;
    if (ageMs > this.recencyWindowMs) return null;
    return ageMs / 60000;
  }

  /**
   * Get summary for truth response — used when user asks about uploads.
   */
  getSummary(): {
    totalRecent: number;
    indexed: number;
    processing: number;
    failed: number;
    uploads: RecentUpload[];
    lastUploadTimestamp: number | null;
  } {
    const recent = this.getRecent();
    return {
      totalRecent: recent.length,
      indexed: recent.filter(u => u.status === 'indexed').length,
      processing: recent.filter(u => u.status === 'processing').length,
      failed: recent.filter(u => u.status === 'failed').length,
      uploads: recent,
      lastUploadTimestamp: recent.length > 0 ? recent[0].timestamp : null,
    };
  }

  /**
   * Get all recent document IDs (for recency boosting in knowledge augmenter).
   */
  getRecentDocumentIds(): Set<string> {
    const cutoff = Date.now() - this.recencyWindowMs;
    const ids = new Set<string>();
    for (const [id, upload] of this.uploads) {
      if (upload.timestamp >= cutoff && upload.status === 'indexed') {
        ids.add(id);
      }
    }
    return ids;
  }

  /**
   * Cleanup expired entries.
   */
  cleanup(): void {
    const cutoff = Date.now() - this.recencyWindowMs;
    for (const [id, upload] of this.uploads) {
      if (upload.timestamp < cutoff) {
        this.uploads.delete(id);
      }
    }
  }

  /**
   * Get count of tracked uploads.
   */
  get size(): number {
    return this.uploads.size;
  }
}

/** Singleton instance — shared across the application */
let _instance: RecentUploadStore | null = null;

export function getRecentUploadStore(): RecentUploadStore {
  if (!_instance) {
    _instance = new RecentUploadStore(60); // 60-minute window
  }
  return _instance;
}
