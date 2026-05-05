// @ts-nocheck
/**
 * Self-Improvement Controller — Phase B (Suggestion Only)
 *
 * Gathers failed scenario results, clusters failure patterns,
 * generates repair suggestions, and produces self-improvement proposals.
 *
 * SAFETY: Default behavior is SUGGEST ONLY — never auto-apply.
 * autoApplyAllowed is always false in this phase.
 * Phase D (auto-apply with rollback) can be enabled later
 * but is architecturally wired here as disabled.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '../logger.js';
import type {
  ValidationRun,
  ValidationFailure,
  RepairSuggestion,
  SelfImprovementProposal,
  Subsystem,
} from './types.js';

const log = createLogger('validation:self-improvement');

// ---------------------------------------------------------------------------
// Failure Pattern — clustered failures
// ---------------------------------------------------------------------------

export interface FailurePattern {
  subsystem: Subsystem;
  dimension: string;
  count: number;
  scenarioIds: string[];
  commonExplanation: string;
}

// ---------------------------------------------------------------------------
// SelfImprovementController
// ---------------------------------------------------------------------------

export class SelfImprovementController {
  private suggestions: RepairSuggestion[] = [];
  private proposals: SelfImprovementProposal[] = [];
  private dataDir: string;
  private autoApplyEnabled: boolean = false; // Phase D — disabled by default

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(os.homedir(), '.agentx', 'validation');
    this.loadState();
    log.info({ autoApply: this.autoApplyEnabled }, 'Self-improvement controller initialized');
  }

  // -----------------------------------------------------------------------
  // Phase B: Analyze Failures
  // -----------------------------------------------------------------------

  /** Analyze failed runs and cluster failure patterns */
  analyzeFailures(runs: ValidationRun[]): FailurePattern[] {
    const failedRuns = runs.filter(r => !r.pass && r.status !== 'skipped');
    const patternMap = new Map<string, FailurePattern>();

    for (const run of failedRuns) {
      for (const failure of run.failures) {
        const subsystem = this.inferSubsystem(run.scenarioId, failure);
        const key = `${subsystem}:${failure.dimension}`;

        if (!patternMap.has(key)) {
          patternMap.set(key, {
            subsystem,
            dimension: failure.dimension,
            count: 0,
            scenarioIds: [],
            commonExplanation: failure.explanation,
          });
        }

        const pattern = patternMap.get(key)!;
        pattern.count++;
        if (!pattern.scenarioIds.includes(run.scenarioId)) {
          pattern.scenarioIds.push(run.scenarioId);
        }
      }
    }

    const patterns = Array.from(patternMap.values())
      .sort((a, b) => b.count - a.count);

    log.info({ patternCount: patterns.length, failedRuns: failedRuns.length }, 'Failure analysis complete');
    return patterns;
  }

  // -----------------------------------------------------------------------
  // Phase B: Generate Repair Suggestions
  // -----------------------------------------------------------------------

  /** Generate repair suggestions from failure patterns */
  generateRepairSuggestions(patterns: FailurePattern[]): RepairSuggestion[] {
    const newSuggestions: RepairSuggestion[] = [];

    for (const pattern of patterns) {
      const suggestion = this.patternToSuggestion(pattern);
      if (suggestion) {
        newSuggestions.push(suggestion);
        this.suggestions.push(suggestion);
      }
    }

    this.saveState();
    log.info({ count: newSuggestions.length }, 'Generated repair suggestions');
    return newSuggestions;
  }

  // -----------------------------------------------------------------------
  // Phase C: Generate Improvement Proposals
  // -----------------------------------------------------------------------

  /** Generate self-improvement proposals from repair suggestions */
  generateImprovementProposals(suggestions: RepairSuggestion[]): SelfImprovementProposal[] {
    const newProposals: SelfImprovementProposal[] = [];

    for (const suggestion of suggestions) {
      if (suggestion.confidence < 0.5) continue; // skip low-confidence suggestions

      const proposal: SelfImprovementProposal = {
        id: `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        targetSubsystem: suggestion.subsystem,
        reason: suggestion.issue,
        proposedChange: suggestion.suggestedFix,
        expectedBenefit: `Fix ${suggestion.subsystem} ${suggestion.issue.slice(0, 80)}`,
        validationRequired: true,
        autoApplyAllowed: false, // ALWAYS false in Phase A/B
        createdAt: Date.now(),
        status: 'proposed',
      };

      newProposals.push(proposal);
      this.proposals.push(proposal);
    }

    this.saveState();
    log.info({ count: newProposals.length }, 'Generated improvement proposals');
    return newProposals;
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  getSuggestions(): RepairSuggestion[] {
    return [...this.suggestions];
  }

  getProposals(): SelfImprovementProposal[] {
    return [...this.proposals];
  }

  getPendingSuggestions(): RepairSuggestion[] {
    return this.suggestions.filter(s => s.status === 'pending');
  }

  getPendingProposals(): SelfImprovementProposal[] {
    return this.proposals.filter(p => p.status === 'proposed');
  }

  /** Update a suggestion status (reviewed, applied, rejected) */
  updateSuggestionStatus(id: string, status: RepairSuggestion['status']): void {
    const suggestion = this.suggestions.find(s => s.id === id);
    if (suggestion) {
      suggestion.status = status;
      this.saveState();
    }
  }

  /** Update a proposal status */
  updateProposalStatus(id: string, status: SelfImprovementProposal['status']): void {
    const proposal = this.proposals.find(p => p.id === id);
    if (proposal) {
      proposal.status = status;
      this.saveState();
    }
  }

  // -----------------------------------------------------------------------
  // Pattern → Suggestion Mapping
  // -----------------------------------------------------------------------

  private patternToSuggestion(pattern: FailurePattern): RepairSuggestion | null {
    const issueMap: Record<string, { issue: string; fix: string; confidence: number }> = {
      'correctness': {
        issue: `Correctness failures in ${pattern.subsystem} (${pattern.count} occurrences)`,
        fix: `Review ${pattern.subsystem} output generation logic. ${pattern.commonExplanation}`,
        confidence: 0.7,
      },
      'evidenceQuality': {
        issue: `Evidence quality issues in ${pattern.subsystem}`,
        fix: `Improve evidence retrieval and scoring in ${pattern.subsystem}. Ensure relevant documents are fetched and ranked properly.`,
        confidence: 0.6,
      },
      'confidenceQuality': {
        issue: `Confidence calibration issues in ${pattern.subsystem}`,
        fix: `Review confidence scoring logic. Confidence values may be consistently too high or too low.`,
        confidence: 0.5,
      },
      'latencyQuality': {
        issue: `Latency budget exceeded in ${pattern.subsystem}`,
        fix: `Profile ${pattern.subsystem} execution path. Consider caching, query optimization, or parallelization.`,
        confidence: 0.5,
      },
      'execution': {
        issue: `Runtime execution errors in ${pattern.subsystem}`,
        fix: `Add error handling and input validation in ${pattern.subsystem}. ${pattern.commonExplanation}`,
        confidence: 0.8,
      },
    };

    const mapping = issueMap[pattern.dimension];
    if (!mapping) {
      return {
        id: `suggestion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sourceScenarioId: pattern.scenarioIds[0] || 'unknown',
        subsystem: pattern.subsystem,
        issue: `${pattern.dimension} failures (${pattern.count} occurrences)`,
        suggestedFix: pattern.commonExplanation,
        confidence: 0.4,
        createdAt: Date.now(),
        status: 'pending',
      };
    }

    return {
      id: `suggestion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sourceScenarioId: pattern.scenarioIds[0] || 'unknown',
      subsystem: pattern.subsystem,
      issue: mapping.issue,
      suggestedFix: mapping.fix,
      confidence: mapping.confidence,
      createdAt: Date.now(),
      status: 'pending',
    };
  }

  // -----------------------------------------------------------------------
  // Subsystem inference
  // -----------------------------------------------------------------------

  private inferSubsystem(scenarioId: string, failure: ValidationFailure): Subsystem {
    if (scenarioId.startsWith('voice')) return 'voice';
    if (scenarioId.startsWith('vision')) return 'vision';
    if (scenarioId.startsWith('multimodal')) return 'multimodal';
    if (scenarioId.startsWith('executive')) return 'executive';
    if (scenarioId.startsWith('simulation')) return 'simulation';
    if (scenarioId.startsWith('memory')) return 'memory';
    if (scenarioId.startsWith('resilience')) return 'resilience';
    if (scenarioId.startsWith('app-builder')) return 'app_builder';
    if (scenarioId.startsWith('retrieval')) return 'cognitive';
    if (scenarioId.startsWith('reasoning')) return 'cognitive';
    if (failure.dimension === 'execution') return 'general';
    return 'general';
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private loadState(): void {
    try {
      const suggestionsPath = path.join(this.dataDir, 'suggestions.json');
      const proposalsPath = path.join(this.dataDir, 'proposals.json');

      if (fs.existsSync(suggestionsPath)) {
        this.suggestions = JSON.parse(fs.readFileSync(suggestionsPath, 'utf-8'));
      }
      if (fs.existsSync(proposalsPath)) {
        this.proposals = JSON.parse(fs.readFileSync(proposalsPath, 'utf-8'));
      }

      log.debug({ suggestions: this.suggestions.length, proposals: this.proposals.length }, 'Loaded self-improvement state');
    } catch (error) {
      log.warn({ error }, 'Failed to load self-improvement state — starting fresh');
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });

      const suggestionsPath = path.join(this.dataDir, 'suggestions.json');
      const proposalsPath = path.join(this.dataDir, 'proposals.json');

      fs.writeFileSync(suggestionsPath + '.tmp', JSON.stringify(this.suggestions, null, 2));
      fs.renameSync(suggestionsPath + '.tmp', suggestionsPath);

      fs.writeFileSync(proposalsPath + '.tmp', JSON.stringify(this.proposals, null, 2));
      fs.renameSync(proposalsPath + '.tmp', proposalsPath);
    } catch (error) {
      log.error({ error }, 'Failed to save self-improvement state');
    }
  }
}
