/**
 * AgentX Agent Loop Engine
 * Orchestrates autonomous reasoning cycles
 */

import { createLogger } from '../logger.js';
import { AgentLoopPlanner } from './agent-loop-planner.js';
import { AgentLoopExecutor } from './agent-loop-executor.js';
import { AgentLoopReflector } from './agent-loop-reflection.js';
import { eventBus } from './event-bus.js';
import { runtimeStateStore } from './runtime-state.js';
import type {
  AgentLoopGoal,
  AgentLoopState,
  AgentLoopStatus,
  AgentLoopStatistics,
  AgentLoopConfig,
  AgentLoopContext,
  AgentLoopExecutionResult,
  AgentLoopObservation,
  AgentLoopReflection,
  AgentLoopAdjustment,
} from './agent-loop-types.js';
import type { LearningEngine } from '../learning/learning-engine.js';
type ToolIntelligenceController = any;
import type { EpisodeStore } from '../memory/episodic-memory.js';
import type { KnowledgeFlowEngine } from '../memory/knowledge-flow.js';

const log = createLogger('agent-loop:engine');

/**
 * Agent Loop Engine
 * Main orchestrator for autonomous reasoning cycles
 */
export class AgentLoopEngine {
  private activeLoops = new Map<string, AgentLoopState>();
  private loopHistory: AgentLoopState[] = [];
  private statistics: AgentLoopStatistics = {
    totalLoops: 0,
    successfulLoops: 0,
    failedLoops: 0,
    averageSteps: 0,
    averageDuration: 0,
    toolsUsed: [],
    commonFailures: [],
    successRate: 0,
  };

  private planner: AgentLoopPlanner;
  private executor: AgentLoopExecutor;
  private reflector: AgentLoopReflector;
  private learningEngine: LearningEngine | null = null;
  private toolIntelligence: ToolIntelligenceController | null = null;
  private episodeStore: EpisodeStore | null = null;
  private knowledgeFlow: KnowledgeFlowEngine | null = null;

  private defaultConfig: AgentLoopConfig = {
    maxSteps: 20,
    maxDuration: 300000, // 5 minutes
    maxFailures: 5,
    enableLogging: true,
    enableTelemetry: true,
    enableEventEmission: true,
    enableMemoryLearning: true,
    retryFailedTasks: true,
    maxRetries: 3,
  };

  constructor(
    private context: AgentLoopContext,
    private config: Partial<AgentLoopConfig> = {}
  ) {
    this.config = { ...this.defaultConfig, ...config };

    this.planner = new AgentLoopPlanner(context);
    this.executor = new AgentLoopExecutor(context);
    this.reflector = new AgentLoopReflector(context);

    log.info({ config: this.config }, 'Agent Loop Engine initialized');
  }

  setLearningEngine(engine: LearningEngine): void {
    this.learningEngine = engine;
  }

  setToolIntelligence(controller: ToolIntelligenceController): void {
    this.toolIntelligence = controller;
  }

  setEpisodeStore(store: EpisodeStore): void {
    this.episodeStore = store;
  }

  setKnowledgeFlow(engine: KnowledgeFlowEngine): void {
    this.knowledgeFlow = engine;
  }

  /** Inject BuilderV2 into the agent loop context (late-binding from serve.ts). */
  setBuilderV2(builder: any): void {
    this.context.builderV2 = builder;
  }

  /**
   * Run a single agent loop for a goal
   */
  async runLoop(goal: AgentLoopGoal): Promise<AgentLoopState> {
    const loopId = `loop-${Date.now()}`;
    const startTime = Date.now();

    log.info({ loopId, goal: goal.description }, 'Starting agent loop');

    // === EPISODIC MEMORY — create episode for this loop ===
    let episodeId: string | null = null;
    if (this.episodeStore) {
      try {
        const sessionId = (goal.context?.sessionId as string) || loopId;
        const projectId = goal.context?.projectId as string | undefined;
        const episode = this.episodeStore.createEpisode(sessionId, projectId, goal.description);
        episodeId = episode.id;
        this.episodeStore.addStep(episodeId, 'observation', `Goal: ${goal.description}`);
      } catch (e) {
        log.warn({ error: e }, 'Failed to create episode for loop');
      }
    }

    const multiAgentConfig = this.config as AgentLoopConfig;

    // Emit event
    this.emitEvent('agent.loop.started', {
      loopId,
      goal,
      timestamp: Date.now(),
    });

    // Initialize state — shared by all paths so finally{} always has it
    const state: AgentLoopState = {
      loopId,
      goal,
      plan: null,
      currentStep: 0,
      status: 'planning',
      executionResults: [],
      observations: [],
      reflections: [],
      adjustments: [],
      totalDuration: 0,
      startTime,
    };

    this.activeLoops.set(loopId, state);

    // Track in runtime state store
    runtimeStateStore.addActiveLoop(loopId, state);
    if (this.context.stateStore) {
      this.context.stateStore.addActiveLoop(loopId, state);
    }

    // Batch 7A — durable workflow registration. Every loop becomes a row
    // in workflow_runs so it survives restart and surfaces on the dashboard.
    // Wrapped in try/catch — durability is best-effort; an engine that
    // can't write to SQL must NOT fail the loop.
    const wrs = this.context.workflowRunStore;
    if (wrs) {
      try {
        wrs.start({
          loopId,
          goal: goal.description,
          metadata: { sessionId: goal.context?.sessionId, projectId: goal.context?.projectId },
        });
      } catch (e) {
        log.warn({ loopId, error: e instanceof Error ? e.message : String(e) }, 'WorkflowRunStore.start failed (non-fatal)');
      }
    }
    // Helper used at every state.status transition below — best-effort
    // phase recording, ignores DB errors.
    const recordPhase = (phase: string): void => {
      if (!wrs) return;
      try { wrs.updatePhase(loopId, phase); } catch { /* */ }
    };

    // Flag: set true when a delegation path handles the goal,
    // so the standard plan/execute loop is skipped but finally{} still runs.
    let delegated = false;

    // === CHECKPOINT: run start ===
    if (this.context.checkpointManager && this.context.checkpointStateProvider) {
      try {
        this.context.checkpointManager.createCheckpoint(
          `loop-start:${loopId}`,
          `Agent loop started: ${goal.description.substring(0, 80)}`,
          this.context.checkpointStateProvider as () => any,
        );
        log.debug({ loopId }, 'Checkpoint created: loop-start');
      } catch (e) {
        log.warn({ error: e }, 'Failed to create start checkpoint');
      }
    }

    try {
      // === AUTONOMY GATE CHECK ===
      // Consult AutonomyGate before any autonomous execution path.
      const autonomyLevel = this.context.autonomyGate?.getLevel() ?? 'SUGGEST_ONLY';
      const gateBlocked = autonomyLevel === 'SUGGEST_ONLY';

      if (gateBlocked) {
        log.info({ loopId, autonomyLevel }, 'AutonomyGate: SUGGEST_ONLY — autonomous execution blocked, returning suggestion');
        state.currentStep = 0;
        state.status = 'completed';
        state.executionResults = [{
          taskId: 'autonomy-gate',
          success: true,
          output: `[SUGGEST_ONLY] Suggested action: ${goal.description}. Autonomous execution blocked by AutonomyGate (level=${autonomyLevel}). Escalate to SUPERVISED to enable autonomous builds.`,
          duration: Date.now() - startTime,
          timestamp: Date.now(),
        }];
        state.totalDuration = Date.now() - startTime;
        state.endTime = Date.now();
        state.finalOutcome = {
          success: true,
          summary: `[SUGGEST_ONLY] Goal suggested but not executed: ${goal.description}`,
          metrics: { autonomyGateBlocked: true, autonomyLevel },
        };

        this.statistics.totalLoops++;
        this.statistics.successfulLoops++;

        this.emitEvent('agent.loop.autonomy.blocked', {
          loopId,
          level: autonomyLevel,
          goal: goal.description,
          timestamp: Date.now(),
        });
        this.emitEvent('agent.loop.completed', {
          loopId,
          summary: state.finalOutcome,
          timestamp: Date.now(),
        });

        delegated = true; // Skip all execution paths, flow to finally{}
      }

      // === MULTI-AGENT DELEGATION ===
      // If multi-agent mode is enabled and an orchestrator is available,
      // route the goal through the AgentOrchestrator for coordinated execution.
      if (
        !delegated &&
        multiAgentConfig.enableMultiAgent &&
        this.context.orchestrator
      ) {
        log.info({ loopId, autonomyLevel }, 'AutonomyGate: execution ALLOWED (level=%s)', autonomyLevel);
        log.info({ loopId }, 'Delegating to multi-agent orchestrator');
        try {
          const result = await this.context.orchestrator.executeGoal(
            goal.description,
            this.context.sessionId,
          );
          // Write result into shared state so finally{} lifecycle hooks see it
          state.currentStep = 1;
          state.status = 'completed';
          state.executionResults = [{
            taskId: 'orchestrator',
            success: true,
            output: result,
            duration: Date.now() - startTime,
            timestamp: Date.now(),
          }];
          state.totalDuration = Date.now() - startTime;
          state.endTime = Date.now();
          state.finalOutcome = {
            success: true,
            summary: result,
            metrics: { delegatedToOrchestrator: true },
          };

          this.statistics.totalLoops++;
          this.statistics.successfulLoops++;

          this.emitEvent('agent.loop.completed', {
            loopId,
            summary: state.finalOutcome,
            timestamp: Date.now(),
          });

          delegated = true;
        } catch (error) {
          log.warn({ error }, 'Multi-agent orchestration failed, falling back to single-agent loop');
          // Fall through to standard single-agent loop
        }
      }

      // === AUTONOMOUS BUILD DELEGATION ===
      // If auto-build mode is enabled and the goal description matches build patterns,
      // route to BuildController for the full build pipeline.
      if (
        !delegated &&
        multiAgentConfig.enableAutoBuild &&
        this.context.buildController &&
        this.isBuildGoal(goal.description)
      ) {
        log.info({ loopId }, 'Delegating to autonomous build controller');
        try {
          const buildGoal = {
            id: goal.id,
            title: goal.description.substring(0, 80),
            description: goal.description,
            createdAt: goal.createdAt,
          };
          const buildResult = await this.context.buildController.run(buildGoal);
          const summary = buildResult.success
            ? `Build succeeded in ${buildResult.attempts} attempt(s) with ${buildResult.artifacts.length} artifact(s)`
            : `Build failed after ${buildResult.attempts} attempt(s): ${buildResult.error ?? 'unknown'}`;

          state.currentStep = 1;
          state.status = buildResult.success ? 'completed' : 'failed';
          state.executionResults = [{
            taskId: 'build-controller',
            success: buildResult.success,
            output: summary,
            duration: Date.now() - startTime,
            timestamp: Date.now(),
          }];
          state.totalDuration = Date.now() - startTime;
          state.endTime = Date.now();
          state.finalOutcome = {
            success: buildResult.success,
            summary,
            metrics: {
              delegatedToBuildController: true,
              attempts: buildResult.attempts,
              artifactCount: buildResult.artifacts.length,
            },
          };

          this.statistics.totalLoops++;
          if (buildResult.success) this.statistics.successfulLoops++;
          else this.statistics.failedLoops++;

          this.emitEvent('agent.loop.completed', {
            loopId,
            summary: state.finalOutcome,
            timestamp: Date.now(),
          });

          delegated = true;
        } catch (error) {
          log.warn({ error }, 'Build controller delegation failed, falling back to single-agent loop');
        }
      }

      if (!delegated) {
      // === EXECUTIVE FUNCTION CHECK ===
      if (this.context.executiveController) {
        try {
          const execDecision = await this.context.executiveController.evaluate(goal.description);
          this.emitEvent('agent.loop.executive.decision', {
            loopId,
            decision: execDecision,
            timestamp: Date.now(),
          });
        } catch (e) {
          log.warn({ error: e }, 'Executive evaluation failed, continuing with standard planning');
        }
      }

      // === PLANNING STAGE ===
      state.status = 'planning'; recordPhase('planning');
      state.plan = await this.planner.generatePlan(goal);

      // Update runtime state
      runtimeStateStore.updateActiveLoop(loopId, { plan: state.plan, status: 'planning' });
      if (this.context.stateStore) {
        this.context.stateStore.updateActiveLoop(loopId, { plan: state.plan, status: 'planning' });
      }

      this.emitEvent('agent.loop.planned', {
        loopId,
        plan: state.plan,
        timestamp: Date.now(),
      });

      // === EXECUTION LOOP ===
      while (state.currentStep < state.plan.tasks.length) {
        if (this.shouldStop(state)) {
          state.status = 'stopped'; recordPhase('stopped');
          break;
        }

        const task = state.plan.tasks[state.currentStep];
        state.currentStep++;
        state.status = 'executing'; recordPhase('executing');

        // Execute task
        const result = await this.executor.executeTask(task);
        state.executionResults.push(result);

        // Update runtime state
        runtimeStateStore.updateActiveLoop(loopId, {
          currentStep: state.currentStep,
          status: 'executing',
          executionResults: state.executionResults,
        });
        if (this.context.stateStore) {
          this.context.stateStore.updateActiveLoop(loopId, {
            currentStep: state.currentStep,
            status: 'executing',
            executionResults: state.executionResults,
          });
        }

        // Emit execution event
        this.emitEvent('agent.loop.step.executed', {
          loopId,
          stepNumber: state.currentStep,
          taskId: task.id,
          result,
          timestamp: Date.now(),
        });

        // === OBSERVATION STAGE ===
        state.status = 'observing'; recordPhase('observing');
        const observation: AgentLoopObservation = {
          stepNumber: state.currentStep,
          taskId: task.id,
          executionResult: result,
          buildMetrics: {
            successRate: state.executionResults.filter(r => r.success).length / state.executionResults.length,
            errorCount: state.executionResults.filter(r => !r.success).length,
          },
          projectState: {
            status: result.success ? 'healthy' : 'degraded',
          },
          timestamp: Date.now(),
        };
        state.observations.push(observation);

        // === REFLECTION STAGE ===
        state.status = 'reflecting'; recordPhase('reflecting');
        const reflection = await this.reflector.reflect(observation);
        state.reflections.push(reflection);

        this.emitEvent('agent.loop.reflection', {
          loopId,
          stepNumber: state.currentStep,
          reflection,
          timestamp: Date.now(),
        });

        // === ADJUSTMENT STAGE ===
        if (!reflection.shouldContinue) {
          log.info(
            { loopId, stepNumber: state.currentStep },
            'Loop should not continue based on reflection'
          );
          break;
        }

        if (reflection.recommendedAdjustments && reflection.recommendedAdjustments.length > 0) {
          state.status = 'adjusting'; recordPhase('adjusting');
          const adjustment: AgentLoopAdjustment = {
            stepNumber: state.currentStep,
            reason: reflection.recommendedAdjustments[0],
            planUpdates: {},
            timestamp: Date.now(),
          };
          state.adjustments.push(adjustment);

          this.emitEvent('agent.loop.adjusted', {
            loopId,
            stepNumber: state.currentStep,
            adjustment,
            timestamp: Date.now(),
          });

          // Phase 4.6B: Extract intelligence action tag if present
          const firstRec = reflection.recommendedAdjustments[0];
          const intelMatch = firstRec.match(/\[INTELLIGENCE:(\w+)\]/);
          const repairAction = intelMatch?.[1] ?? 'repair';

          // Refine plan with intelligence-informed feedback
          const enrichedFeedback = intelMatch
            ? `${firstRec} [action=${repairAction}]`
            : firstRec;

          state.plan = await this.planner.refinePlan(
            state.plan,
            enrichedFeedback
          );

          if (intelMatch) {
            log.info({ repairAction, loopId }, 'Intelligence-informed plan refinement: action=%s', repairAction);
          }
        }
      }

      // === COMPLETION ===
      const endTime = Date.now();
      state.totalDuration = endTime - startTime;
      state.status = 'completed';

      const failedStepCount = state.executionResults.filter(r => !r.success).length;
      const loopSuccess = failedStepCount === 0;

      state.finalOutcome = {
        success: loopSuccess,
        summary: this.generateOutcomeSummary(state),
        metrics: this.calculateFinalMetrics(state),
      };

      // Update statistics
      this.statistics.totalLoops++;
      if (loopSuccess) this.statistics.successfulLoops++;
      this.statistics.averageSteps =
        (this.statistics.averageSteps * (this.statistics.totalLoops - 1) + state.currentStep) /
        this.statistics.totalLoops;
      this.statistics.averageDuration =
        (this.statistics.averageDuration * (this.statistics.totalLoops - 1) + state.totalDuration) /
        this.statistics.totalLoops;
      this.statistics.successRate =
        this.statistics.successfulLoops / this.statistics.totalLoops;

      this.emitEvent('agent.loop.completed', {
        loopId,
        success: true,
        totalSteps: state.currentStep,
        duration: state.totalDuration,
        outcome: state.finalOutcome.summary,
        timestamp: endTime,
      });

      // Batch 7A — durable persistence of loop outcome.
      if (wrs) {
        try {
          if (loopSuccess) {
            wrs.markSuccess(loopId, state.finalOutcome.summary);
          } else {
            wrs.markFailure(loopId, `${failedStepCount} step(s) failed`);
          }
        } catch (e) {
          log.warn({ loopId, error: e instanceof Error ? e.message : String(e) }, 'WorkflowRunStore.markSuccess/Failure failed (non-fatal)');
        }
      }

      log.info(
        { loopId, success: true, duration: state.totalDuration, steps: state.currentStep },
        'Agent loop completed'
      );
      } // end if (!delegated) — single-agent path
    } catch (error) {
      const endTime = Date.now();
      state.totalDuration = endTime - startTime;
      state.status = 'failed';

      // Batch 7A — record the failure in workflow_runs.
      if (wrs) {
        try {
          wrs.markFailure(loopId, error instanceof Error ? error.message : String(error));
        } catch (e) {
          log.warn({ loopId, error: e instanceof Error ? e.message : String(e) }, 'WorkflowRunStore.markFailure failed (non-fatal)');
        }
      }

      state.finalOutcome = {
        success: false,
        summary: `Loop failed at step ${state.currentStep}`,
        metrics: { error: error instanceof Error ? error.message : String(error) },
      };

      // Update statistics
      this.statistics.totalLoops++;
      this.statistics.failedLoops++;
      this.statistics.successRate =
        this.statistics.successfulLoops / this.statistics.totalLoops;

      this.emitEvent('agent.loop.failed', {
        loopId,
        reason: state.finalOutcome.summary,
        failedAtStep: state.currentStep,
        error: error instanceof Error ? error.message : String(error),
        timestamp: endTime,
      });

      log.error(
        { loopId, error: error instanceof Error ? error.message : String(error) },
        'Agent loop failed'
      );
    } finally {
      // Move from active to history in all state stores
      this.loopHistory.push(state);
      this.activeLoops.delete(loopId);

      // Batch 7A — durable persistence of the final outcome. This runs
      // for EVERY exit path (SUGGEST_ONLY, multi-agent delegation,
      // builder delegation, standard plan-execute, caught error) so the
      // workflow_runs row is guaranteed terminal-state before we leave.
      // Guarded by !wrs and try/catch so durability stays best-effort.
      if (wrs) {
        try {
          // Only transition the row if it's still in a non-terminal state
          // (the main-loop success/failure branches may have already done it).
          const current = wrs.get(loopId);
          if (current && (current.state === 'running' || current.state === 'paused' || current.state === 'awaiting_approval')) {
            const succeeded = state.status === 'completed' && state.finalOutcome?.success === true;
            if (succeeded) {
              wrs.markSuccess(loopId, state.finalOutcome?.summary ?? 'completed');
            } else {
              wrs.markFailure(loopId, state.finalOutcome?.summary ?? `status=${state.status}`);
            }
          }
        } catch (e) {
          log.warn({ loopId, error: e instanceof Error ? e.message : String(e) }, 'WorkflowRunStore finally durability flush failed (non-fatal)');
        }
      }

      // Persist final state (status, finalOutcome, duration) before moving to history
      runtimeStateStore.updateActiveLoop(loopId, {
        status: state.status,
        finalOutcome: state.finalOutcome,
        totalDuration: state.totalDuration,
        currentStep: state.currentStep,
        executionResults: state.executionResults,
      });
      runtimeStateStore.completeLoop(loopId);
      if (this.context.stateStore) {
        this.context.stateStore.completeLoop(loopId);
      }

      // Continuous Intelligence Layer: persist loop outcome
      if (this.config.enableMemoryLearning && this.context.experienceStore) {
        try {
          this.context.experienceStore.recordLoopOutcome(state);
        } catch (e) {
          log.warn({ error: e }, 'Failed to record loop outcome to experience store');
        }
      }

      // Continuous Intelligence Layer: full feedback loop
      if (this.config.enableMemoryLearning && this.context.feedbackLoop) {
        try {
          const allTools = state.executionResults.flatMap(r => r.toolsCalled ?? []);
          this.context.feedbackLoop.process({
            query: state.goal.description,
            domain: 'general',
            tools: allTools,
            success: state.finalOutcome?.success ?? false,
            durationMs: state.totalDuration,
            resultQuality: state.finalOutcome?.success
              ? state.executionResults.filter(r => r.success).length / Math.max(1, state.executionResults.length)
              : 0,
            reasoningSteps: state.currentStep,
            evidenceSources: [],
            answerConfidence: state.reflections.length > 0
              ? state.reflections[state.reflections.length - 1].confidence
              : 0,
            errorSummary: state.finalOutcome?.success ? undefined : state.finalOutcome?.summary,
          });
        } catch (e) {
          log.warn({ error: e }, 'Failed to run learning feedback loop');
        }
      }

      // Lifelong Memory Core: ingest experience into categorized memory
      if (this.config.enableMemoryLearning && this.context.memoryIngestionEngine) {
        try {
          const memoryId = this.context.memoryIngestionEngine.ingestFromExperience(state);
          // Link ingested memory to the active episode for knowledge-flow reinforcement
          if (memoryId && episodeId && this.episodeStore) {
            this.episodeStore.linkMemory(episodeId, memoryId);
            log.debug({ memoryId, episodeId }, 'Linked loop memory to episode');
          }
        } catch (e) {
          log.warn({ error: e }, 'Failed to ingest experience into categorized memory');
        }
      }

      // Persistent Executive Function Layer: notify controller of loop completion
      if (this.context.executiveController) {
        try {
          const goalId = (goal.context?.executiveGoalId as string) || '';
          const taskNodeId = (goal.context?.executiveTaskNodeId as string) || '';
          if (goalId) {
            this.context.executiveController.notifyLoopCompleted(
              goalId,
              taskNodeId || undefined,
              state.finalOutcome?.success,
              state.finalOutcome?.summary,
            );
          }
        } catch (e) {
          log.warn({ error: e }, 'Failed to notify executive controller of loop completion');
        }
      }

      // Learning Engine: record loop outcome signal
      if (this.learningEngine) {
        try {
          this.learningEngine.recordSignal({
            subsystem: 'agent-loop',
            input: state.goal.description,
            output: state.finalOutcome?.summary ?? state.status,
            success: state.finalOutcome?.success ?? false,
            score: state.finalOutcome?.success
              ? state.executionResults.filter(r => r.success).length / Math.max(1, state.executionResults.length)
              : 0,
            timestamp: Date.now(),
            metadata: {
              loopId,
              steps: state.currentStep,
              duration: state.totalDuration,
              toolsUsed: state.executionResults.flatMap(r => r.toolsCalled ?? []),
            },
          });
        } catch (e) {
          log.warn({ error: e }, 'Failed to record learning signal for loop');
        }
      }

      // Tool Intelligence: record tool execution feedback
      if (this.toolIntelligence) {
        try {
          for (const execResult of state.executionResults) {
            const toolsCalled = execResult.toolsCalled ?? [];
            for (const toolName of toolsCalled) {
              this.toolIntelligence.recordOutcome({
                tool: toolName,
                query: state.goal.description,
                success: execResult.success,
                latencyMs: execResult.duration ?? 0,
                qualityScore: execResult.success ? 0.8 : 0.2,
                error: execResult.error ?? undefined,
                timestamp: Date.now(),
              });
            }
          }
        } catch (e) {
          log.warn({ error: e }, 'Failed to record tool intelligence feedback');
        }
      }

      // === CHECKPOINT: run completion ===
      if (this.context.checkpointManager && this.context.checkpointStateProvider) {
        try {
          const cpName = state.finalOutcome?.success ? 'loop-completed' : 'loop-failed';
          this.context.checkpointManager.createCheckpoint(
            `${cpName}:${loopId}`,
            `Agent loop ${cpName.split('-')[1]}: ${state.finalOutcome?.summary?.substring(0, 80) ?? state.status}`,
            this.context.checkpointStateProvider as () => any,
          );
          log.debug({ loopId, status: state.status }, 'Checkpoint created: %s', cpName);
        } catch (e) {
          log.warn({ error: e }, 'Failed to create completion checkpoint');
        }
      }

      // Episodic Memory: close episode and trigger knowledge flow
      if (this.episodeStore && episodeId) {
        try {
          const success = state.finalOutcome?.success ?? false;
          const score = success
            ? state.executionResults.filter(r => r.success).length / Math.max(1, state.executionResults.length)
            : 0;
          this.episodeStore.closeEpisode(episodeId, score, state.finalOutcome?.summary);

          // Trigger knowledge flow reinforcement
          if (this.knowledgeFlow && success) {
            this.knowledgeFlow.reinforceFromEpisode(episodeId);
          }
        } catch (e) {
          log.warn({ error: e }, 'Failed to close episode');
        }
      }
    }

    return state;
  }

  /**
   * Check if loop should stop
   */
  private shouldStop(state: AgentLoopState): boolean {
    const maxSteps = this.config.maxSteps || 20;
    const maxDuration = this.config.maxDuration || 300000;
    const maxFailures = this.config.maxFailures || 5;

    if (state.currentStep >= maxSteps) {
      log.warn({ loopId: state.loopId }, 'Max steps reached');
      return true;
    }

    const elapsed = Date.now() - state.startTime;
    if (elapsed > maxDuration) {
      log.warn({ loopId: state.loopId }, 'Max duration exceeded');
      return true;
    }

    const failureCount = state.executionResults.filter(r => !r.success).length;
    if (failureCount >= maxFailures) {
      log.warn({ loopId: state.loopId }, 'Max failures reached');
      return true;
    }

    return false;
  }

  /**
   * Generate outcome summary
   */
  private generateOutcomeSummary(state: AgentLoopState): string {
    const successCount = state.executionResults.filter(r => r.success).length;
    const failureCount = state.executionResults.filter(r => !r.success).length;
    const durSec = (state.totalDuration / 1000).toFixed(1);

    const stepDetail = failureCount > 0
      ? `${successCount} succeeded, ${failureCount} failed`
      : `${successCount} succeeded`;

    return `Ran ${state.currentStep} steps (${stepDetail}) in ${durSec}s.`;
  }

  /**
   * Calculate final metrics
   */
  private calculateFinalMetrics(state: AgentLoopState) {
    const allTools = new Set<string>();
    state.executionResults.forEach(r => {
      r.toolsCalled?.forEach(tool => allTools.add(tool));
    });

    return {
      totalSteps: state.currentStep,
      successfulSteps: state.executionResults.filter(r => r.success).length,
      failedSteps: state.executionResults.filter(r => !r.success).length,
      totalDuration: state.totalDuration,
      toolsUsed: Array.from(allTools),
      reflectionCount: state.reflections.length,
      adjustmentCount: state.adjustments.length,
    };
  }

  /**
   * Check if a goal description looks like a build/app-generation request.
   */
  private isBuildGoal(description: string): boolean {
    const lower = description.toLowerCase();
    const buildKeywords = [
      'build an app', 'build a web', 'build a cli', 'build a library',
      'create an app', 'create a web', 'create a cli', 'scaffold',
      'generate a project', 'generate an app', 'build a mobile',
      'create a project', 'build me',
    ];
    return buildKeywords.some(kw => lower.includes(kw));
  }

  /**
   * Emit event through event bus and context bus
   */
  private emitEvent(eventType: string, payload: unknown): void {
    if (this.config.enableEventEmission) {
      // Emit to backend event bus
      eventBus.emit(eventType, payload);

      // Also emit to context event bus if provided
      if (this.context.eventBus) {
        this.context.eventBus.emit(eventType, payload);
      }

      log.debug({ eventType, payload }, 'Event emitted');
    }
  }

  /**
   * Get active loops
   */
  getActiveLoops(): AgentLoopState[] {
    return Array.from(this.activeLoops.values());
  }

  /**
   * Get loop history
   */
  getLoopHistory(): AgentLoopState[] {
    return this.loopHistory;
  }

  /**
   * Get loop state by ID
   */
  getLoopState(loopId: string): AgentLoopState | undefined {
    return this.activeLoops.get(loopId) || this.loopHistory.find(l => l.loopId === loopId);
  }

  /**
   * Get statistics
   */
  getStatistics(): AgentLoopStatistics {
    return { ...this.statistics };
  }

  /**
   * Stop a running loop
   */
  stopLoop(loopId: string): void {
    const state = this.activeLoops.get(loopId);
    if (state) {
      state.status = 'stopped';
      // Batch 7A — persist the stop transition if WorkflowRunStore is wired.
      try { this.context.workflowRunStore?.markPaused(loopId, 'stopped via stopLoop()'); } catch { /* */ }
      this.activeLoops.delete(loopId);
      this.loopHistory.push(state);
      log.info({ loopId }, 'Loop stopped');
    }
  }
}
