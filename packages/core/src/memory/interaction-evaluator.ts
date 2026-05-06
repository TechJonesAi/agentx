/**
 * Interaction Evaluator — Decides what to remember from chat interactions
 *
 * PRINCIPLE: Only store HIGH-VALUE information. Memory must become
 * intelligence, not storage spam.
 *
 * Evaluates user messages + assistant responses and returns a
 * storage decision with category, tags, and reasoning.
 *
 * This is a LOCAL, deterministic evaluator. It does NOT call an LLM.
 * All decisions are based on pattern matching and heuristics.
 */

import { createLogger } from '../logger.js';
import type { MemoryCategory } from './categorized-memory.js';

const log = createLogger('memory:interaction-evaluator');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StorageDecision {
  shouldStore: boolean;
  category: MemoryCategory;
  content: string;
  tags: string[];
  source: string;
  reason: string;
  confidence: number;
}

export interface InteractionEvaluatorConfig {
  /** Minimum message length to consider for storage (default: 20) */
  minMessageLength: number;
  /** Minimum confidence to store (default: 0.5) */
  minConfidence: number;
  /** Enable deduplication check against existing memories (default: true) */
  deduplication: boolean;
}

const DEFAULT_CONFIG: InteractionEvaluatorConfig = {
  minMessageLength: 20,
  minConfidence: 0.5,
  deduplication: true,
};

// ---------------------------------------------------------------------------
// Pattern definitions — what makes an interaction worth remembering
// ---------------------------------------------------------------------------

/** Explicit teach patterns — user directly telling the system a fact */
const TEACH_PATTERNS = [
  /\b(remember|note|know|learn|keep in mind|store|save)\b.*\b(that|this|:)/i,
  /\b(my name is|i am|i'm|i work at|i live in|my job|my role)\b/i,
  /\b(important|critical|always|never|rule|policy)\b.*:/i,
  /\bfyi\b/i,
];

/** Preference patterns — recurring user choices */
const PREFERENCE_PATTERNS = [
  /\b(i prefer|i always|i never|i like|i hate|i want you to)\b/i,
  /\b(prefer|rather|instead of|don't use|always use|never use)\b/i,
  /\b(style|format|tone|approach|method|convention)\b.*\b(should be|must be|is)\b/i,
  /\b(use|write in|code in|format as)\b.*\b(typescript|python|javascript|rust|go|markdown)\b/i,
];

/** Project/domain facts — factual statements about the user's domain */
const FACT_PATTERNS = [
  /\b(the project|our system|the codebase|the app|the api)\b.*\b(uses|is|runs|requires|depends)\b/i,
  /\b(database|server|deployment|architecture|stack)\b.*\b(is|runs on|uses)\b/i,
  /\b(api key|endpoint|port|url|path)\b.*\b(is|=|:)\b/i,
  /\b(team|colleague|manager|boss|client)\b.*\b(is|named|called)\b/i,
];

/** Correction patterns — user correcting the assistant */
const CORRECTION_PATTERNS = [
  /\b(no|wrong|incorrect|actually|that's not right|correction)\b/i,
  /\b(should be|should have been|it's actually|the correct)\b/i,
];

/** Low-value patterns — things NOT worth storing */
const NOISE_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it|great|good|nice)/i,
  /^(what|how|why|when|where|who|can you|could you|please|help)/i,
  /^(show me|tell me|explain|describe|list|find)/i,
  /\b(test|testing|just checking|ignore this)\b/i,
];

// ---------------------------------------------------------------------------
// InteractionEvaluator
// ---------------------------------------------------------------------------

export class InteractionEvaluator {
  private config: InteractionEvaluatorConfig;
  private deduplicationSet: Set<string> = new Set();

  constructor(config?: Partial<InteractionEvaluatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluate a user message and optionally the assistant response.
   * Returns a StorageDecision indicating whether and how to store.
   */
  evaluate(userMessage: string, assistantResponse?: string): StorageDecision {
    const trimmed = userMessage.trim();

    // Too short — skip
    if (trimmed.length < this.config.minMessageLength) {
      return this.skip('Message too short');
    }

    // ── Priority 1: Explicit teach (checked BEFORE noise filter) ──
    for (const pattern of TEACH_PATTERNS) {
      if (pattern.test(trimmed)) {
        const content = this.extractTeachContent(trimmed);
        if (content.length >= 10) {
          return {
            shouldStore: true,
            category: 'user_teaching',
            content,
            tags: this.extractTags(trimmed),
            source: 'chat_explicit',
            reason: 'User explicitly teaching the system',
            confidence: 0.9,
          };
        }
      }
    }

    // ── Priority 2: Correction (checked BEFORE noise filter — "no" at start is a correction, not noise) ──
    for (const pattern of CORRECTION_PATTERNS) {
      if (pattern.test(trimmed) && assistantResponse && trimmed.length > 30) {
        return {
          shouldStore: true,
          category: 'user_teaching',
          content: `Correction: ${trimmed}`,
          tags: ['correction', ...this.extractTags(trimmed)],
          source: 'chat_correction',
          reason: 'User correcting assistant — high learning value',
          confidence: 0.85,
        };
      }
    }

    // Noise filter — skip greetings, questions, commands
    for (const pattern of NOISE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return this.skip('Low-value interaction (greeting/question/command)');
      }
    }

    // ── Priority 3: Preference declaration ──
    for (const pattern of PREFERENCE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          shouldStore: true,
          category: 'user_teaching',
          content: trimmed,
          tags: ['preference', ...this.extractTags(trimmed)],
          source: 'chat_preference',
          reason: 'User expressing a preference',
          confidence: 0.8,
        };
      }
    }

    // ── Priority 4: Domain facts ──
    for (const pattern of FACT_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          shouldStore: true,
          category: 'research',
          content: trimmed,
          tags: this.extractTags(trimmed),
          source: 'chat_fact',
          reason: 'User stating a project/domain fact',
          confidence: 0.7,
        };
      }
    }

    // ── Default: not worth storing ──
    return this.skip('No high-value pattern matched');
  }

  /**
   * Deduplication check — returns true if content is too similar to existing.
   */
  isDuplicate(content: string): boolean {
    if (!this.config.deduplication) return false;

    const normalized = this.normalize(content);
    if (this.deduplicationSet.has(normalized)) return true;

    this.deduplicationSet.add(normalized);
    return false;
  }

  /**
   * Seed the deduplication set from existing memories.
   */
  seedDeduplication(existingContents: string[]): void {
    for (const c of existingContents) {
      this.deduplicationSet.add(this.normalize(c));
    }
    log.debug({ count: existingContents.length }, 'Deduplication set seeded');
  }

  private skip(reason: string): StorageDecision {
    return {
      shouldStore: false,
      category: 'experience',
      content: '',
      tags: [],
      source: 'chat',
      reason,
      confidence: 0,
    };
  }

  private extractTeachContent(message: string): string {
    // Try to extract the actual fact from teach framing
    const colonSplit = message.match(/(?:remember|note|know|learn).*?[:\-]\s*(.+)/is);
    if (colonSplit) return colonSplit[1].trim();

    const thatSplit = message.match(/(?:remember|note|know|learn)\s+that\s+(.+)/is);
    if (thatSplit) return thatSplit[1].trim();

    return message;
  }

  private extractTags(message: string): string[] {
    const tags: string[] = [];
    if (/\b(typescript|javascript|python|rust|go)\b/i.test(message)) tags.push('code');
    if (/\b(database|sql|sqlite|postgres)\b/i.test(message)) tags.push('database');
    if (/\b(api|endpoint|rest|graphql)\b/i.test(message)) tags.push('api');
    if (/\b(deploy|docker|kubernetes|ci|cd)\b/i.test(message)) tags.push('devops');
    if (/\b(team|colleague|manager|company|org)\b/i.test(message)) tags.push('people');
    if (/\b(project|codebase|repo|repository)\b/i.test(message)) tags.push('project');
    return tags;
  }

  private normalize(content: string): string {
    return content.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }
}
