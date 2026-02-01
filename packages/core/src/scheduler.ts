import * as cron from 'node-cron';
import type { ScheduledTask } from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('scheduler');

export class Scheduler {
  private tasks = new Map<string, { task: ScheduledTask; job: cron.ScheduledTask }>();

  schedule(task: ScheduledTask): void {
    if (!cron.validate(task.cronExpression)) {
      throw new Error(`Invalid cron expression: ${task.cronExpression}`);
    }

    const job = cron.schedule(task.cronExpression, async () => {
      log.info({ taskId: task.id, name: task.name }, 'Running scheduled task');
      try {
        await task.handler();
      } catch (error) {
        log.error({ taskId: task.id, error }, 'Scheduled task failed');
      }
    }, { scheduled: task.enabled });

    this.tasks.set(task.id, { task, job });
    log.info({ taskId: task.id, name: task.name, cron: task.cronExpression }, 'Task scheduled');
  }

  cancel(taskId: string): boolean {
    const entry = this.tasks.get(taskId);
    if (!entry) return false;

    entry.job.stop();
    this.tasks.delete(taskId);
    log.info({ taskId }, 'Task cancelled');
    return true;
  }

  enable(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (entry) {
      entry.job.start();
      entry.task.enabled = true;
    }
  }

  disable(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (entry) {
      entry.job.stop();
      entry.task.enabled = false;
    }
  }

  list(): ScheduledTask[] {
    return Array.from(this.tasks.values()).map((e) => e.task);
  }

  stopAll(): void {
    for (const [, entry] of this.tasks) {
      entry.job.stop();
    }
    this.tasks.clear();
    log.info('All scheduled tasks stopped');
  }
}
