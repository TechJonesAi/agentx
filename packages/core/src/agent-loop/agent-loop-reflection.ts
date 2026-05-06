/**
 * Agent Loop Reflection
 * Analyzes outcomes and provides feedback
 */

import { createLogger } from '../logger.js';
import type {
  AgentLoopObservation,
  AgentLoopReflection,
  AgentLoopExecutionResult,
  AgentLoopContext,
} from './agent-loop-types.js';

const log = createLogger('agent-loop:reflection');

/**
 * Agent Loop Reflector
 * Evaluates execution outcomes and generates feedback
 */
export class AgentLoopReflector {
  private previousErrorCount = 0;
  private successfulSteps = 0;
  private failedSteps = 0;

  constructor(private context: AgentLoopContext) {}

  /**
   * Reflect on an observation
   */
  async reflect(observation: AgentLoopObservation): Promise<AgentLoopReflection> {
    log.info(
      { stepNumber: observation.stepNumber, taskId: observation.taskId },
      'Reflecting on observation'
    );

    const result = observation.executionResult;
    const metrics = this.calculateMetrics(observation);

    // Track success/failure
    if (result.success) {
      this.successfulSteps++;
    } else {
      this.failedSteps++;
    }

    const reflection: AgentLoopReflection = {
      stepNumber: observation.stepNumber,
      observation,
      analysis: this.generateAnalysis(observation, metrics),
      successMetrics: metrics,
      shouldContinue: this.shouldContinue(observation, metrics),
      recommendedAdjustments: this.generateRecommendations(
        observation,
        metrics
      ),
      confidence: this.calculateConfidence(observation, metrics),
      timestamp: Date.now(),
    };

    log.info(
      {
        stepNumber: reflection.stepNumber,
        shouldContinue: reflection.shouldContinue,
        confidence: reflection.confidence,
      },
      'Reflection complete'
    );

    // Continuous Intelligence Layer: record per-step tool outcomes
    if (this.context.experienceStore && result.toolsCalled) {
      const domain = this.inferDomain(observation.taskId);
      for (const tool of result.toolsCalled) {
        try {
          this.context.experienceStore.recordToolOutcome(
            tool, domain, 'step', result.success, result.duration,
          );
        } catch (err) {
          log.warn({ error: err, tool }, 'Failed to record tool outcome');
        }
      }
    }

    // Continuous Intelligence Layer: Memory Reinforcement (Feature 4)
    if (result.success && this.context.longTermMemory && this.context.experienceStore) {
      const memorable = this.extractMemorable(result);
      if (memorable) {
        try {
          const memory = this.context.longTermMemory as any;
          if (typeof memory.store === 'function') {
            const domain = this.inferDomain(observation.taskId);
            memory.store(memorable, ['auto-learned', domain]);
            log.info({ domain }, 'Reinforced long-term memory with step output');
          }
        } catch (err) {
          log.warn({ error: err }, 'Failed to reinforce long-term memory');
        }
      }
    }

    return reflection;
  }

  /**
   * Calculate success metrics
   */
  private calculateMetrics(observation: AgentLoopObservation) {
    const errorCount = observation.projectState?.errors?.length || 0;
    const errorReduction =
      this.previousErrorCount > 0
        ? Math.max(0, (this.previousErrorCount - errorCount) / this.previousErrorCount)
        : errorCount === 0
          ? 1
          : 0;

    this.previousErrorCount = errorCount;

    const progressMade = observation.executionResult.success ? 0.5 : 0.1;
    const toolsUsed = observation.executionResult.toolsCalled?.length || 0;
    const toolEfficiency = toolsUsed > 0 ? observation.executionResult.success ? 1 : 0.5 : 0;

    return {
      errorReduction: Math.min(1, Math.max(0, errorReduction)),
      progressMade: Math.min(1, Math.max(0, progressMade)),
      toolEfficiency: Math.min(1, Math.max(0, toolEfficiency)),
    };
  }

  /**
   * Generate analysis text
   */
  private generateAnalysis(
    observation: AgentLoopObservation,
    metrics: Record<string, number>
  ): string {
    const result = observation.executionResult;
    let analysis = '';

    if (result.success) {
      analysis = `Task succeeded. `;
      if (metrics.errorReduction > 0) {
        analysis += `Reduced errors by ${Math.round(metrics.errorReduction * 100)}%. `;
      }
      if (result.toolsCalled && result.toolsCalled.length > 0) {
        analysis += `Used ${result.toolsCalled.length} tool(s). `;
      }
    } else {
      analysis = `Task failed: ${result.error}. `;
      analysis += 'Will retry or adjust strategy. ';
    }

    if (observation.buildMetrics) {
      const { successRate = 0 } = observation.buildMetrics;
      analysis += `Build success rate: ${Math.round(successRate * 100)}%. `;
    }

    return analysis.trim();
  }

  /**
   * Determine if loop should continue
   */
  private shouldContinue(
    observation: AgentLoopObservation,
    metrics: Record<string, number>
  ): boolean {
    // Phase 4.6B: Consult failure intelligence for early termination
    if (!observation.executionResult.success && this.context.buildIntelligenceService) {
      try {
        const errorText = observation.executionResult.error ?? '';
        const recs = this.context.buildIntelligenceService.getBuildRecommendations('build');
        if (recs?.recurring_blockers?.length) {
          const matchedBlocker = recs.recurring_blockers.find(
            (b: any) => errorText.includes(b.error_class) || b.error_class === errorText,
          );
          if (matchedBlocker?.best_action === 'skip') {
            log.info({ error_class: matchedBlocker.error_class, action: 'skip' },
              'Intelligence: recurring blocker matched — recommending skip (stop loop)');
            return false;
          }
        }
      } catch { /* non-critical */ }
    }

    // Continue if we made progress or recovered from failure
    return (
      observation.executionResult.success ||
      metrics.errorReduction > 0 ||
      this.failedSteps < 3 // Allow up to 3 failures
    );
  }

  /**
   * Generate recommendations for adjustments
   */
  private generateRecommendations(
    observation: AgentLoopObservation,
    metrics: Record<string, number>
  ): string[] {
    const recommendations: string[] = [];
    const result = observation.executionResult;

    if (!result.success) {
      // Phase 4.6B: Consult blocker intelligence for typed repair recommendations
      let intelligenceApplied = false;
      if (this.context.buildIntelligenceService) {
        try {
          const recs = this.context.buildIntelligenceService.getBuildRecommendations('build');
          const errorText = result.error ?? '';

          // Match against recurring blockers for targeted repair action
          if (recs?.recurring_blockers?.length) {
            const blocker = recs.recurring_blockers.find(
              (b: any) => errorText.includes(b.error_class) || b.error_class === errorText,
            );
            if (blocker?.best_action) {
              recommendations.push(`[INTELLIGENCE:${blocker.best_action}] Recurring blocker "${blocker.error_class}" detected — apply ${blocker.best_action} strategy`);
              intelligenceApplied = true;
              log.info({ error_class: blocker.error_class, action: blocker.best_action },
                'Intelligence: mapped failure to repair action');
            }
          }

          // Warn about high-risk files
          if (recs?.high_risk_files?.length) {
            const taskPath = (observation as any).taskId ?? '';
            const riskyMatch = recs.high_risk_files.find((f: string) => taskPath.includes(f));
            if (riskyMatch) {
              recommendations.push(`[INTELLIGENCE:protect] High-risk file "${riskyMatch}" — use protective repair strategy`);
              intelligenceApplied = true;
            }
          }
        } catch { /* non-critical */ }
      }

      if (!intelligenceApplied) {
        recommendations.push('Retry failed task with adjusted parameters');
        recommendations.push('Consider alternative approach');
      }
    }

    if (metrics.errorReduction < 0.5 && result.success) {
      recommendations.push('Increase repair depth for next iteration');
    }

    if (result.toolsCalled && result.toolsCalled.length === 0) {
      recommendations.push('Engage more tools for better coverage');
    }

    if (
      observation.projectState?.errors &&
      observation.projectState.errors.length > 5
    ) {
      recommendations.push('Focus on highest-impact errors first');
    }

    return recommendations;
  }

  /**
   * Calculate confidence in the reflection
   */
  private calculateConfidence(
    observation: AgentLoopObservation,
    metrics: Record<string, number>
  ): number {
    let confidence = 0.5; // Base confidence

    // Increase confidence if task succeeded
    if (observation.executionResult.success) {
      confidence += 0.2;
    }

    // Increase confidence if we have good metrics
    if (metrics.errorReduction > 0) {
      confidence += 0.15;
    }

    // Decrease confidence if we have errors
    if (observation.projectState?.errors && observation.projectState.errors.length > 0) {
      confidence -= 0.05;
    }

    return Math.min(1, Math.max(0, confidence));
  }

  /**
   * Get reflection statistics
   */
  getStatistics() {
    return {
      successfulSteps: this.successfulSteps,
      failedSteps: this.failedSteps,
      successRate: this.successfulSteps / Math.max(1, this.successfulSteps + this.failedSteps),
    };
  }

  /**
   * Reset statistics for next loop
   */
  resetStatistics(): void {
    this.successfulSteps = 0;
    this.failedSteps = 0;
    this.previousErrorCount = 0;
  }

  private extractMemorable(result: AgentLoopExecutionResult): string | null {
    if (!result.output) return null;
    const output = typeof result.output === 'string'
      ? result.output
      : JSON.stringify(result.output);
    // Only store substantive outputs (> 50 chars, < 2000 chars)
    if (output.length < 50 || output.length > 2000) return null;
    // Skip trivial status-only outputs
    if (output.includes('"status"') && !output.includes('"error"') && output.length < 200) return null;
    return output;
  }

  private inferDomain(taskId: string): string {
    const lower = taskId.toLowerCase();
    if (lower.includes('build') || lower.includes('compile')) return 'build';
    if (lower.includes('test') || lower.includes('spec')) return 'testing';
    if (lower.includes('fix') || lower.includes('repair')) return 'repair';
    if (lower.includes('inspect') || lower.includes('analyze')) return 'analysis';
    return 'general';
  }
}
