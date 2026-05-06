/**
 * Memory Ingestion Engine — Lifelong Memory Core
 *
 * Detects and ingests explicit teachings from chat, experience outcomes
 * from agent loops, and research findings. Handles deduplication
 * deterministically via content hash + trigram Jaccard similarity.
 */

import { createLogger } from '../logger.js';
import type { Message } from '../types.js';
import {
  type CategorizedMemoryStore,
  type MemoryEventBus,
} from './categorized-memory.js';
import {
  contentHash,
  jaccardTrigramSimilarity,
  normalizeContent,
} from './memory-policies.js';

/** Minimal subset of AgentLoopState used by ingestion (structurally compatible with the full type). */
interface AgentLoopState {
  loopId?: string;
  goal?: { description?: string };
  currentStep: number;
  totalDuration: number;
  finalOutcome?: { success: boolean; summary?: string; metrics?: Record<string, unknown> };
}

const log = createLogger('memory:ingestion');

// ---------------------------------------------------------------------------
// Teaching detection patterns
// ---------------------------------------------------------------------------

const TEACHING_PATTERNS = [
  /^remember\s+(that\s+)?/i,
  /^note\s+(that\s+)?/i,
  /^always\s+/i,
  /^never\s+/i,
  /^i\s+prefer\s+/i,
  /^i\s+like\s+/i,
  /^i\s+want\s+you\s+to\s+/i,
  /^my\s+name\s+is\s+/i,
  /^i\s+am\s+/i,
  /^i'm\s+/i,
  /^when\s+i\s+say\s+/i,
  /^from\s+now\s+on\s+/i,
  /^keep\s+in\s+mind\s+/i,
  /^important:\s+/i,
  /^fyi:\s+/i,
];

const TAG_EXTRACTION_PATTERNS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /\bprefer(s|ence)?\b/i, tag: 'preference' },
  { pattern: /\bstyle\b/i, tag: 'style' },
  { pattern: /\bname\b/i, tag: 'identity' },
  { pattern: /\brole\b/i, tag: 'role' },
  { pattern: /\blanguage\b/i, tag: 'language' },
  { pattern: /\bframework\b/i, tag: 'framework' },
  { pattern: /\btool\b/i, tag: 'tool' },
  { pattern: /\bproject\b/i, tag: 'project' },
  { pattern: /\bworkflow\b/i, tag: 'workflow' },
];

// Near-duplicate threshold (Jaccard trigram similarity)
const NEAR_DUPLICATE_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// MemoryIngestionEngine
// ---------------------------------------------------------------------------

export class MemoryIngestionEngine {
  private store: CategorizedMemoryStore;
  private eventBus?: MemoryEventBus;
  private ingestCount = 0;
  private duplicateCount = 0;
  private reinforceCount = 0;

  constructor(
    store: CategorizedMemoryStore,
    deps?: { eventBus?: MemoryEventBus },
  ) {
    this.store = store;
    this.eventBus = deps?.eventBus;
    log.info('MemoryIngestionEngine initialized');
  }

  // -----------------------------------------------------------------------
  // Teaching Detection
  // -----------------------------------------------------------------------

  detectTeaching(message: string): {
    isTeaching: boolean;
    content?: string;
    tags?: string[];
  } {
    const trimmed = message.trim();
    if (trimmed.length < 5) return { isTeaching: false };

    for (const pattern of TEACHING_PATTERNS) {
      if (pattern.test(trimmed)) {
        // Extract the actual teaching content
        const content = trimmed.replace(pattern, '').trim();
        if (content.length < 3) continue;

        // Extract tags
        const tags: string[] = [];
        for (const { pattern: tagPattern, tag } of TAG_EXTRACTION_PATTERNS) {
          if (tagPattern.test(trimmed)) {
            tags.push(tag);
          }
        }

        return {
          isTeaching: true,
          content: trimmed, // Store full message as the teaching
          tags,
        };
      }
    }

    return { isTeaching: false };
  }

  // -----------------------------------------------------------------------
  // Project Context Detection
  // -----------------------------------------------------------------------

  detectProjectContext(messages: Message[]): {
    projectId?: string;
    projectName?: string;
  } {
    // Look for project references in recent messages
    const recentMessages = messages.slice(-10);

    for (const msg of recentMessages) {
      if (!msg.content) continue;

      // Match patterns like "project: X", "working on X project", etc.
      const projectPatterns = [
        /project[:\s]+["']?([a-zA-Z0-9_-]+)["']?/i,
        /working\s+on\s+["']?([a-zA-Z0-9_-]+)["']?\s+project/i,
        /in\s+the\s+["']?([a-zA-Z0-9_-]+)["']?\s+(?:repo|repository|project|codebase)/i,
      ];

      for (const pattern of projectPatterns) {
        const match = msg.content.match(pattern);
        if (match?.[1]) {
          const projectName = match[1];
          return {
            projectId: projectName.toLowerCase(),
            projectName,
          };
        }
      }
    }

    return {};
  }

  // -----------------------------------------------------------------------
  // Ingestion Methods
  // -----------------------------------------------------------------------

  ingestFromChat(
    message: string,
    sessionId: string,
    projectId?: string,
  ): string | null {
    const teaching = this.detectTeaching(message);
    if (!teaching.isTeaching || !teaching.content) return null;

    // Check for duplicates
    const existing = this.findDuplicate(teaching.content);
    if (existing) {
      this.store.reinforce(existing.id);
      this.reinforceCount++;
      log.debug({ existingId: existing.id }, 'Duplicate teaching detected, reinforcing');
      return existing.id;
    }

    const id = this.store.teach(teaching.content, teaching.tags, {
      projectId,
      source: `chat:${sessionId}`,
    });

    this.ingestCount++;
    log.debug({ id, tags: teaching.tags }, 'Chat teaching ingested');
    return id;
  }

  ingestFromExperience(state: AgentLoopState): string | null {
    try {
      if (!state.finalOutcome) return null;

      const goalDesc = state.goal?.description ?? 'unknown goal';
      const success = state.finalOutcome.success;
      const summary = state.finalOutcome.summary ?? '';
      const steps = state.currentStep;
      const duration = state.totalDuration;

      // Build experience content
      const content = [
        `Goal: ${goalDesc}`,
        `Outcome: ${success ? 'success' : 'failure'}`,
        summary ? `Summary: ${summary}` : '',
        `Steps: ${steps}, Duration: ${duration}ms`,
      ].filter(Boolean).join('. ');

      // Check for duplicates
      const existing = this.findDuplicate(content);
      if (existing) {
        this.store.reinforce(existing.id);
        this.reinforceCount++;
        return existing.id;
      }

      const tags = ['experience', success ? 'success' : 'failure'];
      const id = this.store.store(content, 'experience', {
        source: `loop:${state.loopId ?? 'unknown'}`,
        tags,
      });

      this.ingestCount++;
      log.debug({ id, success }, 'Experience ingested');
      return id;
    } catch (error) {
      log.warn({ error }, 'Failed to ingest experience — degrading gracefully');
      return null;
    }
  }

  ingestFromResearch(
    query: string,
    findings: string,
    domain: string,
  ): string | null {
    try {
      if (!findings || findings.length < 10) return null;

      const content = `Research: ${query}. Findings: ${findings}`;

      // Check for duplicates
      const existing = this.findDuplicate(content);
      if (existing) {
        this.store.reinforce(existing.id);
        this.reinforceCount++;
        return existing.id;
      }

      const id = this.store.store(content, 'research', {
        source: `research:${domain}`,
        tags: ['research', domain],
      });

      this.ingestCount++;
      log.debug({ id, domain }, 'Research ingested');
      return id;
    } catch (error) {
      log.warn({ error }, 'Failed to ingest research — degrading gracefully');
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Multimodal Ingestion
  // -----------------------------------------------------------------------

  /**
   * Ingest processed multimodal content (transcriptions, image descriptions)
   * into categorized memory as 'experience' category.
   */
  ingestFromMultimodal(
    blocks: Array<{
      type: string;
      transcription?: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }>,
    sessionId: string,
  ): string[] {
    const ids: string[] = [];

    for (const block of blocks) {
      const content = block.transcription || block.description;
      if (!content || content.startsWith('[') || content.length < 10) continue;

      // Check for duplicates
      const existing = this.findDuplicate(content);
      if (existing) {
        this.store.reinforce(existing.id);
        this.reinforceCount++;
        ids.push(existing.id);
        continue;
      }

      const tags = ['multimodal', block.type];
      if (block.transcription) tags.push('transcription');
      if (block.description) tags.push('description');

      const id = this.store.store(
        `[${block.type}] ${content}`,
        'experience',
        {
          source: `multimodal:${sessionId}`,
          tags,
        },
      );

      this.ingestCount++;
      ids.push(id);
      log.debug({ id, type: block.type }, 'Multimodal content ingested');
    }

    return ids;
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  getDiagnostics(): Record<string, unknown> {
    return {
      totalIngested: this.ingestCount,
      totalDuplicatesDetected: this.duplicateCount,
      totalReinforced: this.reinforceCount,
      nearDuplicateThreshold: NEAR_DUPLICATE_THRESHOLD,
      teachingPatternCount: TEACHING_PATTERNS.length,
    };
  }

  // -----------------------------------------------------------------------
  // Duplicate Detection (deterministic, local)
  // -----------------------------------------------------------------------

  private findDuplicate(content: string): { id: string } | null {
    const hash = contentHash(content);

    // 1. Exact duplicate by content hash
    const exact = this.store.findByContentHash(hash);
    if (exact) {
      this.duplicateCount++;
      return { id: exact.id };
    }

    // 2. Near-duplicate by trigram Jaccard similarity
    const normalized = normalizeContent(content);
    const activeMemories = this.store.getAllActive(200);

    for (const mem of activeMemories) {
      const similarity = jaccardTrigramSimilarity(normalized, mem.content);
      if (similarity >= NEAR_DUPLICATE_THRESHOLD) {
        this.duplicateCount++;
        return { id: mem.id };
      }
    }

    return null;
  }
}
