/**
 * Agent Loop Planner
 * Generates task plans using LLM reasoning
 */

import { createLogger } from '../logger.js';
import type {
  AgentLoopGoal,
  AgentLoopPlan,
  AgentLoopTask,
  AgentLoopContext,
} from './agent-loop-types.js';

const log = createLogger('agent-loop:planner');

/**
 * Agent Loop Planner
 * Transforms a goal into a structured plan
 */
export class AgentLoopPlanner {
  constructor(private context: AgentLoopContext) {}

  /**
   * Generate a plan for the goal
   */
  async generatePlan(goal: AgentLoopGoal): Promise<AgentLoopPlan> {
    log.info({ goal: goal.description }, 'Generating plan for goal');

    // Continuous Intelligence Layer: query past experiences + accumulated intelligence
    let experienceContext = '';

    // Query the feedback loop for accumulated intelligence
    if (this.context.feedbackLoop) {
      try {
        const domain = this.inferDomain(goal.description);
        const intel = this.context.feedbackLoop.getIntelligence(goal.description, domain);

        if (intel.suggestedTools.length > 0) {
          experienceContext += `\nBest tools for ${domain}: ${intel.suggestedTools.join(', ')}\n`;
        }
        if (intel.queryExpansions.length > 0) {
          experienceContext += `\nSuggested research expansions: ${intel.queryExpansions.join(', ')}\n`;
        }
        if (intel.heuristics.length > 0) {
          experienceContext += `\nProven reasoning patterns:\n${intel.heuristics.join('\n')}\n`;
        }
        if (intel.pastQuality > 0) {
          experienceContext += `\nPast quality baseline for ${domain}: ${(intel.pastQuality * 100).toFixed(0)}%\n`;
        }
      } catch (err) {
        log.warn({ error: err }, 'Failed to query feedback loop intelligence');
      }
    }

    // Also query the experience store directly for similar past runs
    if (this.context.experienceStore) {
      try {
        const pastExperiences = this.context.experienceStore.findSimilarExperiences(goal.description, undefined, 3);
        if (pastExperiences.length > 0) {
          log.info({ count: pastExperiences.length }, 'Found similar past experiences');
          const summaries = pastExperiences.map(e =>
            `[${e.success ? 'SUCCESS' : 'FAIL'} q=${e.qualityScore.toFixed(2)}] ${e.toolSequence.join(' → ')}`
          );
          experienceContext += `\nPast experience for similar goals:\n${summaries.join('\n')}\n`;
        }

        const heuristics = this.context.experienceStore.findReasoningHeuristics(
          this.inferDomain(goal.description), 2
        );
        if (heuristics.length > 0) {
          log.info({ count: heuristics.length }, 'Found reasoning heuristics');
          experienceContext += `\nReasoning heuristics:\n${heuristics.map(h => h.reasoningTemplate).join('\n')}\n`;
        }
      } catch (err) {
        log.warn({ error: err }, 'Failed to query experience store for planning');
      }
    }

    // Planning policy: use heuristic for known-template goals, LLM for complex/ambiguous ones
    const useHeuristic = this.shouldUseHeuristic(goal);
    let tasks: AgentLoopTask[];
    let usedLLM = false;

    if (this.context.llmProvider && !useHeuristic) {
      try {
        tasks = await this.generateTasksWithLLM(goal, experienceContext);
        usedLLM = true;
        log.info({ planId: goal.id }, 'Plan generated with LLM (complex goal)');
      } catch (error) {
        log.warn({ error }, 'LLM planning failed, using heuristics');
        tasks = this.generateTasksFromGoal(goal);
      }
    } else {
      if (useHeuristic) {
        log.info({ goal: goal.description.slice(0, 60) }, 'Using heuristic planning (known template)');
      }
      tasks = this.generateTasksFromGoal(goal);
    }

    const plan: AgentLoopPlan = {
      id: `plan-${Date.now()}`,
      goalId: goal.id,
      tasks,
      reasoning: usedLLM
        ? `LLM-generated plan: ${this.generateReasoning(goal, tasks)}`
        : `Heuristic plan: ${this.generateReasoning(goal, tasks)}`,
      expectedOutcome: this.generateExpectedOutcome(goal),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    log.info(
      { planId: plan.id, taskCount: tasks.length, usedLLM },
      'Plan generated'
    );

    return plan;
  }

  /**
   * Generate tasks based on goal type and context
   */
  private generateTasksFromGoal(goal: AgentLoopGoal): AgentLoopTask[] {
    const tasks: AgentLoopTask[] = [];
    const description = goal.description.toLowerCase();

    // Goal: Fix failing build
    if (
      description.includes('fix') &&
      (description.includes('build') || description.includes('failing'))
    ) {
      tasks.push(
        {
          id: `task-1-${Date.now()}`,
          action: 'inspect',
          description: 'Inspect project structure and build configuration',
          parameters: { depth: 2 },
        },
        {
          id: `task-2-${Date.now()}`,
          action: 'analyze',
          description: 'Analyze build errors from logs',
          dependencies: ['task-1'],
          parameters: { errorLimit: 10 },
        },
        {
          id: `task-3-${Date.now()}`,
          action: 'repair',
          description: 'Attempt automatic repair based on error analysis',
          dependencies: ['task-2'],
          parameters: { strategy: 'incremental' },
        },
        {
          id: `task-4-${Date.now()}`,
          action: 'build',
          description: 'Rebuild project to verify fix',
          dependencies: ['task-3'],
        }
      );
    }

    // Goal: Add feature
    if (description.includes('add') || description.includes('feature')) {
      tasks.push(
        {
          id: `task-1-${Date.now()}`,
          action: 'inspect',
          description: 'Inspect current codebase structure',
        },
        {
          id: `task-2-${Date.now()}`,
          action: 'query',
          description: 'Query build memory for relevant patterns',
          dependencies: ['task-1'],
        },
        {
          id: `task-3-${Date.now()}`,
          action: 'modify',
          description: 'Generate and apply code changes',
          dependencies: ['task-2'],
        },
        {
          id: `task-4-${Date.now()}`,
          action: 'build',
          description: 'Build and test changes',
          dependencies: ['task-3'],
        }
      );
    }

    // Goal: Improve / Optimize
    if (description.includes('improve') || description.includes('optimize')) {
      tasks.push(
        {
          id: `task-1-${Date.now()}`,
          action: 'inspect',
          description: 'Analyze current implementation',
        },
        {
          id: `task-2-${Date.now()}`,
          action: 'analyze',
          description: 'Identify optimization opportunities',
          dependencies: ['task-1'],
        },
        {
          id: `task-3-${Date.now()}`,
          action: 'modify',
          description: 'Apply optimizations',
          dependencies: ['task-2'],
        },
        {
          id: `task-4-${Date.now()}`,
          action: 'build',
          description: 'Verify improvements',
          dependencies: ['task-3'],
        }
      );
    }

    // Default: Generic workflow
    if (tasks.length === 0) {
      tasks.push(
        {
          id: `task-1-${Date.now()}`,
          action: 'inspect',
          description: 'Inspect project state',
        },
        {
          id: `task-2-${Date.now()}`,
          action: 'execute',
          description: 'Execute work items',
          dependencies: ['task-1'],
        },
        {
          id: `task-3-${Date.now()}`,
          action: 'analyze',
          description: 'Analyze results',
          dependencies: ['task-2'],
        }
      );
    }

    return tasks;
  }

  /**
   * Generate reasoning explanation for the plan
   */
  private generateReasoning(goal: AgentLoopGoal, tasks: AgentLoopTask[]): string {
    return (
      `Goal: ${goal.description}\n` +
      `Strategy: Executed ${tasks.length} sequential and parallel tasks to accomplish goal.\n` +
      `Approach: ${this.getApproachDescription(goal, tasks)}`
    );
  }

  /**
   * Generate expected outcome description
   */
  private generateExpectedOutcome(goal: AgentLoopGoal): string {
    const description = goal.description.toLowerCase();

    if (description.includes('fix')) {
      return 'Build succeeds with reduced/zero errors';
    } else if (description.includes('add')) {
      return 'Feature implemented and integrated';
    } else if (description.includes('improve')) {
      return 'Performance or quality metrics improved';
    } else {
      return 'Goal objectives accomplished';
    }
  }

  /**
   * Get approach description
   */
  private getApproachDescription(goal: AgentLoopGoal, tasks: AgentLoopTask[]): string {
    const taskActions = tasks.map(t => t.action).join(' → ');
    return `${taskActions}`;
  }

  /**
   * Refine plan based on reflection feedback
   */
  async refinePlan(
    plan: AgentLoopPlan,
    feedback: string
  ): Promise<AgentLoopPlan> {
    log.info(
      { planId: plan.id, feedback },
      'Refining plan based on feedback'
    );

    // Try LLM refinement first
    if (this.context.llmProvider) {
      try {
        return await this.refinePlanWithLLM(plan, feedback);
      } catch (error) {
        log.warn({ error }, 'LLM refinement failed, using simple strategy');
      }
    }

    // Simple refinement: add retry task
    const refinedPlan = {
      ...plan,
      tasks: [
        ...plan.tasks,
        {
          id: `task-retry-${Date.now()}`,
          action: 'repair' as const,
          description: `Retry based on feedback: ${feedback.substring(0, 100)}...`,
          dependencies: [plan.tasks[plan.tasks.length - 1]?.id].filter(Boolean),
        },
      ],
      updatedAt: Date.now(),
      reasoning: `${plan.reasoning}\n\nRefined based on: ${feedback}`,
    };

    return refinedPlan;
  }

  /**
   * Generate tasks using LLM
   */
  private async generateTasksWithLLM(goal: AgentLoopGoal, experienceContext = ''): Promise<AgentLoopTask[]> {
    if (!this.context.llmProvider) {
      throw new Error('LLM provider not available');
    }

    const prompt = `You are an autonomous agent planner. Given the following goal, generate a structured plan of tasks to accomplish it.

Goal: ${goal.description}
${goal.context ? `Context: ${JSON.stringify(goal.context, null, 2)}` : ''}
${goal.constraints && goal.constraints.length > 0 ? `Constraints: ${goal.constraints.join(', ')}` : ''}
${experienceContext}
Generate a list of tasks in JSON format. Each task should have:
- id: unique identifier (string)
- action: one of 'inspect', 'analyze', 'build', 'repair', 'modify', 'query', 'execute'
- description: clear description of what the task does
- dependencies: array of task IDs this depends on (can be empty)
- parameters: optional object with task-specific parameters

Keep the plan concise (3-5 tasks maximum). Return ONLY the JSON array, starting with [ and ending with ].`;

    const response = await this.context.llmProvider.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1024,
    });

    const content = response.content || '';

    // Extract JSON array from response
    const jsonMatch = content.match(/\[\s*[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No valid JSON array found in LLM response');
    }

    const taskData = JSON.parse(jsonMatch[0]);

    return taskData.map((t: any) => ({
      id: t.id || `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      action: t.action || 'analyze',
      description: t.description || 'Task',
      dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
      parameters: typeof t.parameters === 'object' ? t.parameters : {},
    }));
  }

  /**
   * Refine plan using LLM
   */
  private async refinePlanWithLLM(
    plan: AgentLoopPlan,
    feedback: string
  ): Promise<AgentLoopPlan> {
    if (!this.context.llmProvider) {
      throw new Error('LLM provider not available');
    }

    const prompt = `You are refining an agent execution plan based on feedback.

Current Tasks: ${JSON.stringify(plan.tasks, null, 2)}
Feedback: ${feedback}

Based on the feedback, suggest modifications. Return JSON with:
- tasksToRemove: array of task IDs to remove (can be empty)
- tasksToAdd: array of new task objects to add (can be empty)
- summary: brief summary of changes

Return ONLY the JSON object, starting with { and ending with }.`;

    const response = await this.context.llmProvider.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 512,
    });

    const content = response.content || '';

    // Extract JSON object from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // If parsing fails, just add a retry task
      return {
        ...plan,
        tasks: [
          ...plan.tasks,
          {
            id: `task-retry-${Date.now()}`,
            action: 'repair' as const,
            description: `Retry with adjusted strategy`,
            dependencies: [plan.tasks[plan.tasks.length - 1]?.id].filter(Boolean),
          },
        ],
        updatedAt: Date.now(),
      };
    }

    const modifications = JSON.parse(jsonMatch[0]);
    const newTasks = [...plan.tasks];

    // Remove specified tasks
    const tasksToRemove = modifications.tasksToRemove || [];
    for (const id of tasksToRemove) {
      const idx = newTasks.findIndex(t => t.id === id);
      if (idx >= 0) newTasks.splice(idx, 1);
    }

    // Add new tasks
    const tasksToAdd = modifications.tasksToAdd || [];
    for (const t of tasksToAdd) {
      newTasks.push({
        id: t.id || `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        action: t.action || 'analyze',
        description: t.description || 'Task',
        dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
        parameters: typeof t.parameters === 'object' ? t.parameters : {},
      });
    }

    return {
      ...plan,
      tasks: newTasks,
      updatedAt: Date.now(),
      reasoning: `${plan.reasoning}\n\nRefined: ${modifications.summary || 'Plan adjusted based on feedback'}`,
    };
  }

  /**
   * Determine if heuristic planning is sufficient for this goal.
   * Returns true when the goal matches a known keyword template, is short,
   * and has no constraints — i.e. the heuristic will produce a good plan.
   * Returns false for complex/ambiguous goals that benefit from LLM reasoning.
   */
  private shouldUseHeuristic(goal: AgentLoopGoal): boolean {
    const desc = goal.description.toLowerCase();
    const hasConstraints = goal.constraints && goal.constraints.length > 0;
    const isLong = goal.description.length > 80;

    // Analytical/diagnostic goals should always use LLM regardless of keywords
    const isAnalytical =
      desc.includes('analyse') || desc.includes('analyze') ||
      desc.includes('identify') || desc.includes('evaluate') ||
      desc.includes('review') || desc.includes('diagnose') ||
      desc.includes('suggest') || desc.includes('recommend') ||
      desc.includes('compare') || desc.includes('assess');

    if (isAnalytical) return false;

    // Known templates the heuristic handles well
    const matchesTemplate =
      (desc.includes('fix') && (desc.includes('build') || desc.includes('failing'))) ||
      desc.includes('add') || desc.includes('feature') ||
      desc.includes('improve') || desc.includes('optimize');

    return matchesTemplate && !isLong && !hasConstraints;
  }

  private inferDomain(description: string): string {
    const lower = description.toLowerCase();
    if (lower.includes('build') || lower.includes('compile')) return 'build';
    if (lower.includes('test') || lower.includes('spec')) return 'testing';
    if (lower.includes('deploy') || lower.includes('release')) return 'deployment';
    if (lower.includes('fix') || lower.includes('bug')) return 'repair';
    if (lower.includes('feature') || lower.includes('add')) return 'feature';
    if (lower.includes('refactor') || lower.includes('optimize')) return 'optimization';
    if (lower.includes('research') || lower.includes('search')) return 'research';
    return 'general';
  }
}
