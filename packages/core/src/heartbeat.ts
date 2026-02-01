import { createLogger } from './logger.js';

const log = createLogger('heartbeat');

export type MessageSender = (userId: string, platform: string, message: string) => Promise<void>;

export interface HeartbeatTarget {
  userId: string;
  platform: string;
  /** Recipient identifier on the platform (e.g. chat ID, phone number) */
  recipient: string;
}

export interface HeartbeatRule {
  id: string;
  name: string;
  /** Cron expression (e.g. '0 8 * * *' for 8am daily) */
  cronExpression: string;
  /** Prompt sent to the LLM to generate the proactive message */
  prompt: string;
  /** Targets to send the message to */
  targets: HeartbeatTarget[];
  enabled: boolean;
}

export interface HeartbeatConfig {
  enabled: boolean;
  /** Default interval in minutes for simple heartbeats (if no cron rules) */
  intervalMinutes: number;
  rules: HeartbeatRule[];
}

type GenerateMessage = (prompt: string) => Promise<string>;

export class HeartbeatManager {
  private rules = new Map<string, HeartbeatRule>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private cronJobs = new Map<string, { stop: () => void }>();
  private messageSender: MessageSender | null = null;
  private messageGenerator: GenerateMessage | null = null;
  private running = false;

  setMessageSender(sender: MessageSender): void {
    this.messageSender = sender;
  }

  setMessageGenerator(generator: GenerateMessage): void {
    this.messageGenerator = generator;
  }

  addRule(rule: HeartbeatRule): void {
    this.rules.set(rule.id, rule);
    log.info({ ruleId: rule.id, name: rule.name }, 'Heartbeat rule added');

    if (this.running && rule.enabled) {
      this.startRule(rule);
    }
  }

  removeRule(ruleId: string): void {
    this.stopRule(ruleId);
    this.rules.delete(ruleId);
    log.info({ ruleId }, 'Heartbeat rule removed');
  }

  enableRule(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = true;
      if (this.running) {
        this.startRule(rule);
      }
    }
  }

  disableRule(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = false;
      this.stopRule(ruleId);
    }
  }

  listRules(): HeartbeatRule[] {
    return Array.from(this.rules.values());
  }

  private async executeRule(rule: HeartbeatRule): Promise<void> {
    if (!this.messageSender) {
      log.warn({ ruleId: rule.id }, 'No message sender configured');
      return;
    }

    let message: string;
    if (this.messageGenerator) {
      try {
        message = await this.messageGenerator(rule.prompt);
      } catch (error) {
        log.error({ ruleId: rule.id, error }, 'Failed to generate heartbeat message');
        return;
      }
    } else {
      message = rule.prompt;
    }

    for (const target of rule.targets) {
      try {
        await this.messageSender(target.recipient, target.platform, message);
        log.info({
          ruleId: rule.id,
          target: target.recipient,
          platform: target.platform,
        }, 'Heartbeat message sent');
      } catch (error) {
        log.error({
          ruleId: rule.id,
          target: target.recipient,
          error,
        }, 'Failed to send heartbeat message');
      }
    }
  }

  private startRule(rule: HeartbeatRule): void {
    this.stopRule(rule.id);

    // Parse cron or use simple interval
    if (rule.cronExpression) {
      try {
        // Dynamic import to avoid hard dependency
        import('node-cron').then((cron) => {
          if (!cron.validate(rule.cronExpression)) {
            log.error({ ruleId: rule.id, cron: rule.cronExpression }, 'Invalid cron expression');
            return;
          }

          const job = cron.schedule(rule.cronExpression, () => {
            this.executeRule(rule).catch((err) => {
              log.error({ ruleId: rule.id, error: err }, 'Heartbeat execution error');
            });
          });

          this.cronJobs.set(rule.id, job);
          log.info({ ruleId: rule.id, cron: rule.cronExpression }, 'Heartbeat cron job started');
        }).catch(() => {
          log.warn({ ruleId: rule.id }, 'node-cron not available, falling back to interval');
          this.startIntervalFallback(rule);
        });
      } catch {
        this.startIntervalFallback(rule);
      }
    } else {
      this.startIntervalFallback(rule);
    }
  }

  private startIntervalFallback(rule: HeartbeatRule): void {
    // Default to 60 minute interval
    const intervalMs = 60 * 60 * 1000;
    const timer = setInterval(() => {
      this.executeRule(rule).catch((err) => {
        log.error({ ruleId: rule.id, error: err }, 'Heartbeat execution error');
      });
    }, intervalMs);

    this.timers.set(rule.id, timer);
    log.info({ ruleId: rule.id, intervalMs }, 'Heartbeat interval started');
  }

  private stopRule(ruleId: string): void {
    const timer = this.timers.get(ruleId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(ruleId);
    }

    const cronJob = this.cronJobs.get(ruleId);
    if (cronJob) {
      cronJob.stop();
      this.cronJobs.delete(ruleId);
    }
  }

  start(): void {
    this.running = true;
    for (const rule of this.rules.values()) {
      if (rule.enabled) {
        this.startRule(rule);
      }
    }
    log.info({ ruleCount: this.rules.size }, 'Heartbeat manager started');
  }

  stop(): void {
    this.running = false;
    for (const ruleId of this.rules.keys()) {
      this.stopRule(ruleId);
    }
    log.info('Heartbeat manager stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Get all unique targets across all rules. */
  getTargets(): HeartbeatTarget[] {
    const seen = new Set<string>();
    const targets: HeartbeatTarget[] = [];
    for (const rule of this.rules.values()) {
      for (const target of rule.targets) {
        const key = `${target.platform}:${target.recipient}`;
        if (!seen.has(key)) {
          seen.add(key);
          targets.push(target);
        }
      }
    }
    return targets;
  }

  /** Send an alert message directly to a specific recipient. */
  async sendAlert(recipient: string, platform: string, message: string): Promise<void> {
    if (!this.messageSender) {
      log.warn('No message sender configured for alert');
      return;
    }
    await this.messageSender(recipient, platform, message);
  }
}
