/**
 * Verified Context Builder — Aggregates tool results into scored, verified context.
 *
 * Phase 3 of P6-11 Hybrid Controller system.
 * Takes raw results from cognitive_query + web_search, applies authority scoring,
 * evidence weighting, and contradiction detection, then produces a VerifiedContext
 * that is the SOLE input for the reasoner model.
 *
 * The reasoner ONLY sees VerifiedContext — never raw tool results.
 */

import { createLogger } from '../logger.js';
import { scoreSourceAuthority, type SourceAuthority } from '../tools/source-authority.js';

const log = createLogger('hybrid:verified-context');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryEvidence {
  content: string;
  source: string;
  type: 'memory' | 'document' | 'email' | 'teaching';
  weight: 'primary' | 'legal_authority' | 'secondary';
  confidence: number;
  citation: string;
}

export interface ExternalEvidence {
  content: string;
  url: string;
  title: string;
  authority: SourceAuthority;
  authorityLabel: string;
  weight: 'legal_authority' | 'secondary';
  confidence: number;
  citation: string;
}

export interface AuthorityScore {
  source: string;
  authority: SourceAuthority;
  label: string;
  confidence: number;
}

export interface WeightedEvidenceItem {
  content: string;
  source: string;
  weight: 'primary' | 'legal_authority' | 'secondary';
  confidence: number;
  citation: string;
  origin: 'memory' | 'external';
}

export interface DetectedContradiction {
  claim1: { content: string; source: string; origin: string };
  claim2: { content: string; source: string; origin: string };
  type: 'memory_vs_law' | 'document_vs_document' | 'memory_vs_external' | 'temporal_conflict';
  resolution: string;
}

export interface VerifiedContext {
  memoryEvidence: MemoryEvidence[];
  externalEvidence: ExternalEvidence[];
  authorityScores: AuthorityScore[];
  weightedEvidence: WeightedEvidenceItem[];
  contradictions: DetectedContradiction[];
  confidenceScore: number;
  /** Pre-formatted text block for injection into reasoner system prompt */
  contextBlock: string;
  /** Metadata about the verification process */
  metadata: {
    toolsExecuted: string[];
    forcedTools: string[];
    controllerConfidence: number;
    totalEvidenceItems: number;
    highAuthorityCount: number;
    domain: string;
  };
}

// ---------------------------------------------------------------------------
// Evidence Classification
// ---------------------------------------------------------------------------

/**
 * Classify memory evidence weight based on source type and content.
 */
function classifyMemoryWeight(
  sourceType: string,
  content: string,
): { weight: MemoryEvidence['weight']; confidence: number } {
  const lower = content.toLowerCase();

  // Primary: uploaded documents, emails, contracts
  if (sourceType === 'document' || sourceType === 'email' ||
      /\b(?:contract|agreement|signed|dated|attached|enclosed|payslip|letter|p45|p60)\b/i.test(lower)) {
    return { weight: 'primary', confidence: 0.9 };
  }

  // Legal authority: statute references, official guidance
  if (/\b(?:ERA|Employment Rights Act|section \d+|s\.\d+|legislation\.gov|tribunal|ACAS)\b/i.test(lower)) {
    return { weight: 'legal_authority', confidence: 0.95 };
  }

  // Secondary: user teachings, verbal claims, general memory
  return { weight: 'secondary', confidence: 0.5 };
}

/**
 * Classify external evidence weight based on authority.
 */
function classifyExternalWeight(
  authority: SourceAuthority,
): { weight: ExternalEvidence['weight']; confidence: number } {
  switch (authority) {
    case 'HIGH':
      return { weight: 'legal_authority', confidence: 0.95 };
    case 'MEDIUM':
      return { weight: 'legal_authority', confidence: 0.75 };
    case 'LOW':
    default:
      return { weight: 'secondary', confidence: 0.4 };
  }
}

// ---------------------------------------------------------------------------
// Contradiction Detection (lightweight, cross-source)
// ---------------------------------------------------------------------------

const CONTRADICTION_PATTERNS = [
  { pattern: /no\s+(?:right|entitlement|obligation|requirement)/i, topic: 'rights/obligations' },
  { pattern: /(?:statutory|legal)\s+(?:minimum|requirement|right|entitlement)/i, topic: 'statutory rights' },
  { pattern: /(?:not\s+entitled|cannot\s+claim|no\s+claim)/i, topic: 'entitlements' },
  { pattern: /(?:must|shall|required\s+to|obliged\s+to)/i, topic: 'obligations' },
  { pattern: /\b(?:ERA|Employment Rights Act|section\s+\d+)\b/i, topic: 'legislation' },
  { pattern: /\b(?:notice\s+period|redundancy|unfair\s+dismissal|wrongful\s+termination)\b/i, topic: 'employment law' },
];

function detectContradictions(
  memoryItems: MemoryEvidence[],
  externalItems: ExternalEvidence[],
): DetectedContradiction[] {
  const contradictions: DetectedContradiction[] = [];

  // Compare each memory item against each external item
  for (const mem of memoryItems) {
    for (const ext of externalItems) {
      // Only compare items that share topic relevance
      const sharedTopics = CONTRADICTION_PATTERNS.filter(
        p => p.pattern.test(mem.content) && p.pattern.test(ext.content),
      );
      if (sharedTopics.length === 0) continue;

      // Check for negation conflicts
      const memHasNegation = /\b(?:no|not|cannot|never|don't|doesn't|isn't|aren't|won't)\b/i.test(mem.content);
      const extHasNegation = /\b(?:no|not|cannot|never|don't|doesn't|isn't|aren't|won't)\b/i.test(ext.content);

      // One positive, one negative on the same topic → potential contradiction
      if (memHasNegation !== extHasNegation) {
        contradictions.push({
          claim1: {
            content: mem.content.slice(0, 200),
            source: mem.source,
            origin: 'memory',
          },
          claim2: {
            content: ext.content.slice(0, 200),
            source: ext.url,
            origin: 'external',
          },
          type: mem.type === 'document' ? 'document_vs_document' : 'memory_vs_law',
          resolution: ext.authority === 'HIGH'
            ? 'External HIGH authority source should take precedence — verify memory is current'
            : 'Cross-reference both sources — neither has definitive authority',
        });
      }

      // Check for conflicting numbers (e.g., notice periods, amounts)
      const memNumbers = mem.content.match(/\b\d+\s*(?:weeks?|months?|days?|years?|%|pounds?|£\d+)\b/gi) ?? [];
      const extNumbers = ext.content.match(/\b\d+\s*(?:weeks?|months?|days?|years?|%|pounds?|£\d+)\b/gi) ?? [];

      if (memNumbers.length > 0 && extNumbers.length > 0) {
        // If they mention numbers for the same topic but different values
        const memNumStr = memNumbers.map(n => n.toLowerCase()).sort().join(',');
        const extNumStr = extNumbers.map(n => n.toLowerCase()).sort().join(',');
        if (memNumStr !== extNumStr && sharedTopics.length > 0) {
          contradictions.push({
            claim1: {
              content: mem.content.slice(0, 200),
              source: mem.source,
              origin: 'memory',
            },
            claim2: {
              content: ext.content.slice(0, 200),
              source: ext.url,
              origin: 'external',
            },
            type: 'memory_vs_external',
            resolution: 'Numeric discrepancy detected — verify against primary legislation',
          });
        }
      }
    }
  }

  return contradictions;
}

// ---------------------------------------------------------------------------
// VerifiedContextBuilder
// ---------------------------------------------------------------------------

export class VerifiedContextBuilder {
  /**
   * Build verified context from raw tool results.
   * This is the SOLE data source for the reasoner model.
   */
  build(
    toolResults: Map<string, string>,
    query: string,
    domain: string,
    controllerConfidence: number,
    forcedTools: string[],
  ): VerifiedContext {
    const memoryEvidence: MemoryEvidence[] = [];
    const externalEvidence: ExternalEvidence[] = [];
    const authorityScores: AuthorityScore[] = [];

    // ── Parse cognitive_query results ──────────────────────────────
    // Items sourced from uploaded documents get [DOC-N] citations;
    // lifelong memory items keep [MEM-N].
    const cogResult = toolResults.get('cognitive_query');
    if (cogResult && !cogResult.startsWith('Error:')) {
      const memItems = this.parseMemoryResults(cogResult);
      let memIdx = 0;
      let docIdx = 0;
      for (let i = 0; i < memItems.length; i++) {
        const item = memItems[i];
        const { weight, confidence } = classifyMemoryWeight(item.type, item.content);
        // Detect document-sourced items by source containing "doc:" prefix
        // or type being "document"/"chunk" or source not being plain "memory"
        const isDocSource = /\bdoc[_:]/.test(item.source) ||
          item.type === 'document' || item.type === 'chunk' ||
          (item.source !== 'memory' && item.source.length > 10);
        const citation = isDocSource
          ? `[DOC-${++docIdx}]`
          : `[MEM-${++memIdx}]`;
        memoryEvidence.push({
          content: item.content,
          source: item.source,
          type: item.type as MemoryEvidence['type'],
          weight,
          confidence,
          citation,
        });
      }
    }

    // ── Parse web_search results ──────────────────────────────────
    const webResult = toolResults.get('web_search');
    if (webResult && !webResult.startsWith('Error:')) {
      const webItems = this.parseWebResults(webResult);
      for (let i = 0; i < webItems.length; i++) {
        const item = webItems[i];
        const authority = scoreSourceAuthority(item.url);
        const { weight, confidence } = classifyExternalWeight(authority.authority);

        externalEvidence.push({
          content: item.content,
          url: item.url,
          title: item.title,
          authority: authority.authority,
          authorityLabel: authority.label,
          weight,
          confidence,
          citation: `[WEB-${i + 1}]`,
        });

        authorityScores.push({
          source: item.url,
          authority: authority.authority,
          label: authority.label,
          confidence,
        });
      }
    }

    // ── Build weighted evidence list (sorted by confidence) ───────
    const weightedEvidence: WeightedEvidenceItem[] = [
      ...memoryEvidence.map(m => ({
        content: m.content,
        source: m.source,
        weight: m.weight,
        confidence: m.confidence,
        citation: m.citation,
        origin: 'memory' as const,
      })),
      ...externalEvidence.map(e => ({
        content: e.content,
        source: e.url,
        weight: e.weight,
        confidence: e.confidence,
        citation: e.citation,
        origin: 'external' as const,
      })),
    ].sort((a, b) => b.confidence - a.confidence);

    // ── Detect contradictions ─────────────────────────────────────
    const contradictions = detectContradictions(memoryEvidence, externalEvidence);

    // ── Compute overall confidence ────────────────────────────────
    const confidenceScore = this.computeOverallConfidence(
      memoryEvidence,
      externalEvidence,
      contradictions,
    );

    // ── Build formatted context block for reasoner ────────────────
    const contextBlock = this.formatContextBlock(
      memoryEvidence,
      externalEvidence,
      contradictions,
      domain,
      confidenceScore,
    );

    const toolsExecuted = Array.from(toolResults.keys());
    const highAuthorityCount = externalEvidence.filter(e => e.authority === 'HIGH').length;

    log.info({
      memoryItems: memoryEvidence.length,
      externalItems: externalEvidence.length,
      contradictions: contradictions.length,
      confidence: confidenceScore.toFixed(2),
      highAuthority: highAuthorityCount,
      domain,
    }, 'Verified context built');

    return {
      memoryEvidence,
      externalEvidence,
      authorityScores,
      weightedEvidence,
      contradictions,
      confidenceScore,
      contextBlock,
      metadata: {
        toolsExecuted,
        forcedTools,
        controllerConfidence,
        totalEvidenceItems: memoryEvidence.length + externalEvidence.length,
        highAuthorityCount,
        domain,
      },
    };
  }

  /**
   * Parse cognitive_query results into structured items.
   */
  private parseMemoryResults(raw: string): Array<{ content: string; source: string; type: string }> {
    const items: Array<{ content: string; source: string; type: string }> = [];

    // Try JSON parse first
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          items.push({
            content: String(item.content ?? item.text ?? item.chunk ?? ''),
            source: String(item.source ?? item.document ?? item.file ?? 'memory'),
            type: String(item.type ?? item.category ?? 'memory'),
          });
        }
        return items.filter(i => i.content.length > 0);
      }
      if (parsed.results && Array.isArray(parsed.results)) {
        for (const item of parsed.results) {
          items.push({
            content: String(item.content ?? item.text ?? item.chunk ?? ''),
            source: String(item.source ?? item.document ?? item.file ?? 'memory'),
            type: String(item.type ?? item.category ?? 'memory'),
          });
        }
        return items.filter(i => i.content.length > 0);
      }
    } catch {
      // Not JSON — parse as text
    }

    // Fallback: split on double newlines or numbered items
    const sections = raw.split(/\n{2,}|\n(?=\d+\.\s)/).filter(s => s.trim().length > 20);
    for (const section of sections) {
      items.push({
        content: section.trim(),
        source: 'cognitive_memory',
        type: 'memory',
      });
    }

    return items;
  }

  /**
   * Parse web_search results into structured items.
   */
  private parseWebResults(raw: string): Array<{ content: string; url: string; title: string }> {
    const items: Array<{ content: string; url: string; title: string }> = [];

    // Try to parse structured web search output
    // Format: "**[AUTHORITY] Title** (url)\nContent..."
    const blocks = raw.split(/\n(?=\*\*\[|---|\d+\.\s\*\*)/);

    for (const block of blocks) {
      const urlMatch = block.match(/\((https?:\/\/[^\s)]+)\)/);
      const titleMatch = block.match(/\*\*(?:\[(?:HIGH|MEDIUM|LOW)[^\]]*\]\s*)?([^*]+)\*\*/);
      const url = urlMatch?.[1] ?? '';
      const title = titleMatch?.[1]?.trim() ?? '';

      // Extract content: everything after the title/url line
      const lines = block.split('\n').filter(l => l.trim().length > 0);
      const content = lines.slice(1).join('\n').trim();

      if (content.length > 20 || url) {
        items.push({ content: content || block.trim(), url, title });
      }
    }

    // Fallback: if no structured parsing worked, treat as single item
    if (items.length === 0 && raw.trim().length > 20) {
      items.push({ content: raw.trim(), url: '', title: 'Web Search Result' });
    }

    return items;
  }

  /**
   * Compute overall confidence score from evidence quality.
   */
  private computeOverallConfidence(
    memory: MemoryEvidence[],
    external: ExternalEvidence[],
    contradictions: DetectedContradiction[],
  ): number {
    if (memory.length === 0 && external.length === 0) return 0;

    const weights = {
      primary: 1.0,
      legal_authority: 0.95,
      secondary: 0.5,
    };

    let totalWeight = 0;
    let weightedSum = 0;

    for (const m of memory) {
      const w = weights[m.weight];
      totalWeight += w;
      weightedSum += m.confidence * w;
    }
    for (const e of external) {
      const w = weights[e.weight];
      totalWeight += w;
      weightedSum += e.confidence * w;
    }

    let score = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Penalty for contradictions
    score -= contradictions.length * 0.1;

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Format the verified context as a text block for the reasoner's system prompt.
   */
  private formatContextBlock(
    memory: MemoryEvidence[],
    external: ExternalEvidence[],
    contradictions: DetectedContradiction[],
    domain: string,
    confidence: number,
  ): string {
    const parts: string[] = [];

    parts.push('=== VERIFIED CONTEXT (pre-verified — do NOT fetch additional data) ===');
    parts.push(`Domain: ${domain}`);
    parts.push(`Evidence confidence: ${(confidence * 100).toFixed(0)}%`);
    parts.push('');

    // Document evidence (from user uploads — PRIMARY authority)
    const docEvidence = memory.filter(m => m.citation.startsWith('[DOC-'));
    const memEvidence = memory.filter(m => !m.citation.startsWith('[DOC-'));

    if (docEvidence.length > 0) {
      parts.push('--- Document Evidence (from user uploads — PRIMARY) ---');
      parts.push('=== STRICT EVIDENCE MODE ===');
      parts.push('MANDATORY: Quote directly from [DOC-N] sources. These are PRIMARY evidence from the user\'s uploaded documents.');
      parts.push('You MUST include at least one near-verbatim quote from the document text below.');
      parts.push('Web sources are SECONDARY — they supplement but do NOT replace document evidence.');
      parts.push('If text is OCR-degraded, extract the clearest recoverable wording rather than ignoring it.');
      parts.push('=== END STRICT EVIDENCE MODE ===');
      for (const d of docEvidence) {
        parts.push(`${d.citation} [${d.weight.toUpperCase()}] (${d.type}): ${d.content}`);
      }
      parts.push('');
    }

    // Memory evidence
    if (memEvidence.length > 0) {
      parts.push('--- Memory Evidence ---');
      for (const m of memEvidence) {
        parts.push(`${m.citation} [${m.weight.toUpperCase()}] (${m.type}): ${m.content}`);
      }
      parts.push('');
    }

    // External evidence
    if (external.length > 0) {
      parts.push('--- External Evidence ---');
      for (const e of external) {
        const authBadge = e.authority === 'HIGH' ? '[HIGH AUTHORITY]'
          : e.authority === 'MEDIUM' ? '[MEDIUM AUTHORITY]'
            : '[LOW]';
        parts.push(`${e.citation} ${authBadge} ${e.title} (${e.url})`);
        if (e.content) parts.push(`  ${e.content.slice(0, 500)}`);
      }
      parts.push('');
    }

    // Contradictions
    if (contradictions.length > 0) {
      parts.push('--- CONTRADICTIONS DETECTED ---');
      for (let i = 0; i < contradictions.length; i++) {
        const c = contradictions[i];
        parts.push(`Contradiction ${i + 1} (${c.type}):`);
        parts.push(`  Source A (${c.claim1.origin}): ${c.claim1.content}`);
        parts.push(`  Source B (${c.claim2.origin}): ${c.claim2.content}`);
        parts.push(`  Resolution guidance: ${c.resolution}`);
      }
      parts.push('');
    }

    parts.push('=== END VERIFIED CONTEXT ===');

    return parts.join('\n');
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      type: 'VerifiedContextBuilder',
      version: '1.0',
    };
  }
}
