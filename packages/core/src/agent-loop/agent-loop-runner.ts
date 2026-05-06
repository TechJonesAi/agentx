/**
 * Agent Loop Runner
 * CLI and programmatic interface for running agent loops
 */

import { createLogger } from '../logger.js';
import { AgentLoopEngine } from './agent-loop-engine.js';
import type {
  AgentLoopGoal,
  AgentLoopConfig,
  AgentLoopContext,
  AgentLoopState,
} from './agent-loop-types.js';

const log = createLogger('agent-loop:runner');

/**
 * Agent Loop Runner
 * Manages agent loop execution
 */
export class AgentLoopRunner {
  private engine: AgentLoopEngine;

  constructor(
    private context: AgentLoopContext,
    config?: Partial<AgentLoopConfig>
  ) {
    this.engine = new AgentLoopEngine(context, config);
  }

  /**
   * Run a loop from a goal description (CLI usage)
   */
  async runFromDescription(
    description: string,
    constraints?: string[]
  ): Promise<AgentLoopState> {
    const goal: AgentLoopGoal = {
      id: `goal-${Date.now()}`,
      description,
      context: {},
      constraints,
      createdAt: Date.now(),
    };

    return this.engine.runLoop(goal);
  }

  /**
   * Run a structured goal
   */
  async run(goal: AgentLoopGoal): Promise<AgentLoopState> {
    return this.engine.runLoop(goal);
  }

  /**
   * Run multiple sequential loops
   */
  async runSequential(goals: AgentLoopGoal[]): Promise<AgentLoopState[]> {
    const results: AgentLoopState[] = [];

    for (const goal of goals) {
      const result = await this.engine.runLoop(goal);
      results.push(result);

      // Stop if a loop fails
      if (!result.finalOutcome?.success) {
        log.warn('Sequential loop stopped due to failure');
        break;
      }
    }

    return results;
  }

  /**
   * Run multiple parallel loops
   */
  async runParallel(goals: AgentLoopGoal[]): Promise<AgentLoopState[]> {
    return Promise.all(goals.map(goal => this.engine.runLoop(goal)));
  }

  /**
   * Get active loops
   */
  getActiveLoops(): AgentLoopState[] {
    return this.engine.getActiveLoops();
  }

  /**
   * Get loop history
   */
  getHistory(): AgentLoopState[] {
    return this.engine.getLoopHistory();
  }

  /**
   * Get statistics
   */
  getStatistics() {
    return this.engine.getStatistics();
  }

  /**
   * Stop a loop
   */
  stopLoop(loopId: string): void {
    this.engine.stopLoop(loopId);
  }

  /**
   * CLI command: agentx agent run "description"
   */
  static async cliRun(
    description: string,
    context?: AgentLoopContext,
    config?: Partial<AgentLoopConfig>
  ): Promise<void> {
    const runner = new AgentLoopRunner(
      context || {},
      config
    );

    log.info({ description }, 'Running agent loop from CLI');

    const result = await runner.runFromDescription(description);

    // Print results
    console.log('\n=== AGENT LOOP COMPLETE ===');
    console.log(`Loop ID: ${result.loopId}`);
    console.log(`Goal: ${result.goal.description}`);
    console.log(`Status: ${result.status}`);
    console.log(`Steps: ${result.currentStep}`);
    console.log(`Duration: ${result.totalDuration}ms`);
    console.log(`Success: ${result.finalOutcome?.success ? '✓ Yes' : '✗ No'}`);
    console.log(`Summary: ${result.finalOutcome?.summary}`);

    if (result.status === 'failed') {
      console.error('\nLoop failed. Check logs for details.');
      process.exit(1);
    }
  }

  /**
   * CLI command: agentx agent status
   */
  static cliStatus(runner: AgentLoopRunner): void {
    const active = runner.getActiveLoops();
    const stats = runner.getStatistics();

    console.log('\n=== AGENT LOOP STATUS ===');
    console.log(`Active Loops: ${active.length}`);
    console.log(`Total Loops: ${stats.totalLoops}`);
    console.log(`Success Rate: ${Math.round(stats.successRate * 100)}%`);
    console.log(`Average Steps: ${Math.round(stats.averageSteps)}`);
    console.log(`Average Duration: ${Math.round(stats.averageDuration)}ms`);

    if (active.length > 0) {
      console.log('\nActive Loops:');
      active.forEach(loop => {
        console.log(`  - ${loop.loopId}: ${loop.goal.description} (Step ${loop.currentStep})`);
      });
    }
  }

  /**
   * CLI command: agentx agent stop <loop-id>
   */
  static cliStop(runner: AgentLoopRunner, loopId: string): void {
    runner.stopLoop(loopId);
    console.log(`\nLoop ${loopId} stopped.`);
  }
}

/**
 * CLI Entry Point
 * Parse and execute CLI commands
 */
export function parseAndRunAgentLoopCLI(
  args: string[],
  context?: AgentLoopContext,
  config?: Partial<AgentLoopConfig>
): void {
  if (args.length < 1) {
    console.error('Usage: agentx agent <command> [options]');
    console.error('Commands:');
    console.error('  run <description>   - Run an agent loop');
    console.error('  status              - Show agent loop status');
    console.error('  stop <loop-id>      - Stop a running loop');
    process.exit(1);
  }

  const command = args[0];

  switch (command) {
    case 'run': {
      const description = args.slice(1).join(' ');
      if (!description) {
        console.error('Error: Goal description required');
        process.exit(1);
      }
      AgentLoopRunner.cliRun(description, context, config);
      break;
    }

    case 'status': {
      const runner = new AgentLoopRunner(context || {}, config);
      AgentLoopRunner.cliStatus(runner);
      break;
    }

    case 'stop': {
      const loopId = args[1];
      if (!loopId) {
        console.error('Error: Loop ID required');
        process.exit(1);
      }
      const runner = new AgentLoopRunner(context || {}, config);
      AgentLoopRunner.cliStop(runner, loopId);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
