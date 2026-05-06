/**
 * ExperienceStore — Persistent learning backend for the Continuous Intelligence Layer.
 *
 * Owns 5 SQLite tables (experience_records, tool_routing_stats, research_patterns,
 * reasoning_heuristics, multimodal_patterns) and exposes typed read/write methods
 * consumed by the planner, executor, reflector, and engine.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../logger.js';
import type { AgentLoopState } from '../agent-loop-types.js';
import type {
  ExperienceRecord,
  ToolRoutingStat,
  ResearchPattern,
  ReasoningHeuristic,
  MultimodalPattern,
  LearningConfig,
} from './types.js';
import { DEFAULT_LEARNING_CONFIG } from './types.js';

const log = createLogger('learning:experience-store');

export class ExperienceStore {
  private config: LearningConfig;

  constructor(
    private db: Database.Database,
    config?: Partial<LearningConfig>,
  ) {
    this.config = { ...DEFAULT_LEARNING_CONFIG, ...config };
    log.info('ExperienceStore initialized');
  }

  // ---------------------------------------------------------------------------
  // Feature 1: Experience Memory
  // ---------------------------------------------------------------------------

  recordLoopOutcome(state: AgentLoopState): string {
    const id = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const toolSequence = state.executionResults.flatMap(r => r.toolsCalled ?? []);
    const successCount = state.executionResults.filter(r => r.success).length;
    const totalSteps = state.executionResults.length;
    const qualityScore = totalSteps > 0 ? successCount / totalSteps : 0;

    const goalHash = this.normalizeGoal(state.goal.description);
    const domain = this.inferDomain(state.goal.description);

    try {
      this.db.prepare(`
        INSERT INTO experience_records
          (id, goal_description, goal_hash, domain, tool_sequence, success, duration_ms, quality_score, step_count, error_summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        state.goal.description,
        goalHash,
        domain,
        JSON.stringify(toolSequence),
        state.finalOutcome?.success ? 1 : 0,
        state.totalDuration,
        qualityScore,
        state.currentStep,
        state.finalOutcome?.success ? null : state.finalOutcome?.summary ?? null,
        now,
      );

      // Update tool routing stats from this loop
      for (const result of state.executionResults) {
        for (const tool of result.toolsCalled ?? []) {
          this.recordToolOutcome(tool, domain, 'loop', result.success, result.duration);
        }
      }

      // Extract reasoning heuristic if loop was high-quality
      if (state.finalOutcome?.success && qualityScore >= 0.7 && state.plan?.reasoning) {
        this.maybeStoreReasoningHeuristic(state, domain);
      }

      log.info({ id, domain, qualityScore, success: state.finalOutcome?.success }, 'Loop outcome recorded');
    } catch (err) {
      log.warn({ error: err }, 'Failed to record loop outcome');
    }

    return id;
  }

  findSimilarExperiences(goalDescription: string, domain?: string, limit = 5): ExperienceRecord[] {
    const goalHash = this.normalizeGoal(goalDescription);
    const words = goalHash.split(' ').filter(w => w.length > 2).slice(0, 5);

    if (words.length === 0) return [];

    const likeClauses = words.map(() => 'goal_hash LIKE ?').join(' OR ');
    const params: unknown[] = words.map(w => `%${w}%`);

    let sql = `SELECT * FROM experience_records WHERE (${likeClauses})`;
    if (domain) {
      sql += ' AND domain = ?';
      params.push(domain);
    }
    sql += ' ORDER BY quality_score DESC, created_at DESC LIMIT ?';
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as any[];
      return rows.map(r => this.rowToExperience(r));
    } catch (err) {
      log.warn({ error: err }, 'Failed to find similar experiences');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Features 2 + 7: Tool Routing Stats / Speed Optimization
  // ---------------------------------------------------------------------------

  recordToolOutcome(
    toolName: string,
    domain: string,
    actionType: string,
    success: boolean,
    durationMs: number,
  ): void {
    const now = Date.now();
    try {
      // Upsert: INSERT or UPDATE
      const existing = this.db.prepare(
        'SELECT * FROM tool_routing_stats WHERE tool_name = ? AND domain = ? AND action_type = ?',
      ).get(toolName, domain, actionType) as any;

      if (existing) {
        const newCount = existing.invocation_count + 1;
        const newAvg = (existing.avg_duration_ms * existing.invocation_count + durationMs) / newCount;
        this.db.prepare(`
          UPDATE tool_routing_stats
          SET invocation_count = ?, success_count = ?, failure_count = ?, avg_duration_ms = ?, last_used_at = ?
          WHERE tool_name = ? AND domain = ? AND action_type = ?
        `).run(
          newCount,
          existing.success_count + (success ? 1 : 0),
          existing.failure_count + (success ? 0 : 1),
          newAvg,
          now,
          toolName, domain, actionType,
        );
      } else {
        this.db.prepare(`
          INSERT INTO tool_routing_stats
            (tool_name, domain, action_type, invocation_count, success_count, failure_count, avg_duration_ms, last_used_at)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?)
        `).run(toolName, domain, actionType, success ? 1 : 0, success ? 0 : 1, durationMs, now);
      }
    } catch (err) {
      log.warn({ error: err, toolName }, 'Failed to record tool outcome');
    }
  }

  getToolStats(domain: string, actionType?: string): ToolRoutingStat[] {
    try {
      let sql = 'SELECT * FROM tool_routing_stats WHERE domain = ?';
      const params: unknown[] = [domain];
      if (actionType) {
        sql += ' AND action_type = ?';
        params.push(actionType);
      }
      sql += ' ORDER BY success_count DESC';

      const rows = this.db.prepare(sql).all(...params) as any[];
      return rows.map(r => ({
        toolName: r.tool_name,
        domain: r.domain,
        actionType: r.action_type,
        invocationCount: r.invocation_count,
        successCount: r.success_count,
        failureCount: r.failure_count,
        avgDurationMs: r.avg_duration_ms,
        lastUsedAt: r.last_used_at,
      }));
    } catch (err) {
      log.warn({ error: err }, 'Failed to get tool stats');
      return [];
    }
  }

  shouldSkipTool(toolName: string, domain: string, threshold?: number): boolean {
    const effectiveThreshold = threshold ?? this.config.skipToolThreshold;
    const minInvocations = this.config.minInvocationsForSkip;

    try {
      const row = this.db.prepare(
        'SELECT * FROM tool_routing_stats WHERE tool_name = ? AND domain = ?',
      ).get(toolName, domain) as any;

      if (!row || row.invocation_count < minInvocations) return false;

      const failureRate = row.failure_count / row.invocation_count;
      if (failureRate >= effectiveThreshold) {
        log.info(
          { toolName, domain, failureRate, threshold: effectiveThreshold },
          'Recommending tool skip due to high failure rate',
        );
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Feature 3: Research Pattern Learning
  // ---------------------------------------------------------------------------

  storeResearchPattern(
    domain: string,
    originalQuery: string,
    expandedQueries: string[],
    resultQuality: number,
  ): string {
    const id = `rp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    try {
      this.db.prepare(`
        INSERT INTO research_patterns
          (id, domain, original_query, expanded_queries, result_quality, usage_count, success_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(id, domain, originalQuery, JSON.stringify(expandedQueries), resultQuality, resultQuality > 0.5 ? 1 : 0, now, now);
    } catch (err) {
      log.warn({ error: err }, 'Failed to store research pattern');
    }
    return id;
  }

  findResearchPatterns(domain: string, limit = 5): ResearchPattern[] {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM research_patterns WHERE domain = ? ORDER BY result_quality DESC, success_count DESC LIMIT ?',
      ).all(domain, limit) as any[];

      return rows.map(r => ({
        id: r.id,
        domain: r.domain,
        originalQuery: r.original_query,
        expandedQueries: JSON.parse(r.expanded_queries),
        resultQuality: r.result_quality,
        usageCount: r.usage_count,
        successCount: r.success_count,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    } catch (err) {
      log.warn({ error: err }, 'Failed to find research patterns');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Feature 5: Reasoning Heuristic Learning
  // ---------------------------------------------------------------------------

  storeReasoningHeuristic(
    patternName: string,
    domain: string,
    triggerConditions: Record<string, unknown>,
    reasoningTemplate: string,
  ): string {
    const id = `rh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    try {
      this.db.prepare(`
        INSERT INTO reasoning_heuristics
          (id, pattern_name, domain, trigger_conditions, reasoning_template, confidence, usage_count, success_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0.5, 0, 0, ?, ?)
      `).run(id, patternName, domain, JSON.stringify(triggerConditions), reasoningTemplate, now, now);
    } catch (err) {
      log.warn({ error: err }, 'Failed to store reasoning heuristic');
    }
    return id;
  }

  findReasoningHeuristics(domain: string, limit = 3): ReasoningHeuristic[] {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM reasoning_heuristics WHERE domain = ? ORDER BY confidence DESC, success_count DESC LIMIT ?',
      ).all(domain, limit) as any[];

      return rows.map(r => ({
        id: r.id,
        patternName: r.pattern_name,
        domain: r.domain,
        triggerConditions: JSON.parse(r.trigger_conditions),
        reasoningTemplate: r.reasoning_template,
        confidence: r.confidence,
        usageCount: r.usage_count,
        successCount: r.success_count,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    } catch (err) {
      log.warn({ error: err }, 'Failed to find reasoning heuristics');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Feature 6: Multimodal Learning
  // ---------------------------------------------------------------------------

  storeMultimodalPattern(
    mediaType: string,
    contentCategory: string,
    interpretationStrategy: Record<string, unknown>,
  ): string {
    const id = `mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    try {
      this.db.prepare(`
        INSERT INTO multimodal_patterns
          (id, media_type, content_category, interpretation_strategy, confidence, usage_count, success_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0.5, 0, 0, ?, ?)
      `).run(id, mediaType, contentCategory, JSON.stringify(interpretationStrategy), now, now);
    } catch (err) {
      log.warn({ error: err }, 'Failed to store multimodal pattern');
    }
    return id;
  }

  findMultimodalPatterns(mediaType: string, limit = 3): MultimodalPattern[] {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM multimodal_patterns WHERE media_type = ? ORDER BY confidence DESC, success_count DESC LIMIT ?',
      ).all(mediaType, limit) as any[];

      return rows.map(r => ({
        id: r.id,
        mediaType: r.media_type,
        contentCategory: r.content_category,
        interpretationStrategy: JSON.parse(r.interpretation_strategy),
        confidence: r.confidence,
        usageCount: r.usage_count,
        successCount: r.success_count,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    } catch (err) {
      log.warn({ error: err }, 'Failed to find multimodal patterns');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Generic outcome recorder (increments usage_count and optionally success_count)
  // ---------------------------------------------------------------------------

  recordPatternOutcome(
    table: 'research_patterns' | 'reasoning_heuristics' | 'multimodal_patterns',
    id: string,
    success: boolean,
  ): void {
    try {
      const successIncrement = success ? 1 : 0;
      this.db.prepare(`
        UPDATE ${table}
        SET usage_count = usage_count + 1,
            success_count = success_count + ?,
            confidence = CAST(success_count + ? AS REAL) / (usage_count + 1),
            updated_at = ?
        WHERE id = ?
      `).run(successIncrement, successIncrement, Date.now(), id);
    } catch (err) {
      log.warn({ error: err, table, id }, 'Failed to record pattern outcome');
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private normalizeGoal(description: string): string {
    return description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private inferDomain(description: string): string {
    const lower = description.toLowerCase();
    if (lower.includes('build') || lower.includes('compile') || lower.includes('typescript')) return 'build';
    if (lower.includes('test') || lower.includes('spec') || lower.includes('jest')) return 'testing';
    if (lower.includes('deploy') || lower.includes('release') || lower.includes('publish')) return 'deployment';
    if (lower.includes('fix') || lower.includes('bug') || lower.includes('error')) return 'repair';
    if (lower.includes('feature') || lower.includes('add') || lower.includes('implement')) return 'feature';
    if (lower.includes('refactor') || lower.includes('clean') || lower.includes('optimize')) return 'optimization';
    if (lower.includes('research') || lower.includes('search') || lower.includes('find')) return 'research';
    return 'general';
  }

  private maybeStoreReasoningHeuristic(state: AgentLoopState, domain: string): void {
    if (!state.plan?.reasoning) return;

    const taskActions = state.plan.tasks.map(t => t.action).join(' → ');
    const triggerConditions = {
      goalKeywords: this.normalizeGoal(state.goal.description).split(' ').slice(0, 5),
      domain,
    };

    this.storeReasoningHeuristic(
      `${domain}-${taskActions}`,
      domain,
      triggerConditions,
      state.plan.reasoning,
    );
  }

  private rowToExperience(r: any): ExperienceRecord {
    return {
      id: r.id,
      goalDescription: r.goal_description,
      goalHash: r.goal_hash,
      domain: r.domain,
      toolSequence: JSON.parse(r.tool_sequence),
      success: r.success === 1,
      durationMs: r.duration_ms,
      qualityScore: r.quality_score,
      stepCount: r.step_count,
      errorSummary: r.error_summary ?? undefined,
      createdAt: r.created_at,
    };
  }
}
