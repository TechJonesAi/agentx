/**
 * Monitor Command Skill
 *
 * Run shell commands periodically and alert based on:
 * - Non-zero exit code
 * - Output contains a specific string
 * - Output changes between runs
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type AlertWhen = 'exitCode' | 'outputContains' | 'outputChanges';

interface CommandMonitor {
  command: string;
  args: string[];
  intervalMs: number;
  alertWhen: AlertWhen;
  match?: string;
  lastOutput?: string;
  lastExitCode?: number;
  timer: ReturnType<typeof setInterval>;
}

const monitors = new Map<string, CommandMonitor>();
const commandAlerts: Array<{ id: string; command: string; reason: string; output: string; timestamp: number }> = [];

/** Optional callback to send alerts through HeartbeatManager or other notification channel. */
export type AlertSender = (message: string) => Promise<void>;
let alertSender: AlertSender | null = null;

export function setAlertSender(sender: AlertSender): void {
  alertSender = sender;
}

async function runCommand(entry: CommandMonitor): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = await execFileAsync(entry.command, entry.args, {
      timeout: 30_000,
      shell: true,
    });
    return { stdout: result.stdout, exitCode: 0 };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; code?: number };
    return {
      stdout: execError.stdout ?? '',
      exitCode: execError.code ?? 1,
    };
  }
}

function checkAlert(entry: CommandMonitor, stdout: string, exitCode: number): string | null {
  switch (entry.alertWhen) {
    case 'exitCode':
      if (exitCode !== 0) {
        return `Command exited with code ${exitCode}`;
      }
      break;

    case 'outputContains':
      if (entry.match && stdout.includes(entry.match)) {
        return `Output contains "${entry.match}"`;
      }
      break;

    case 'outputChanges':
      if (entry.lastOutput !== undefined && entry.lastOutput !== stdout) {
        return 'Output changed';
      }
      break;
  }
  return null;
}

export const tools = [
  {
    definition: {
      name: 'monitor_command',
      description: 'Run a shell command periodically and alert based on output',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique ID for this monitor' },
          command: { type: 'string', description: 'Shell command to run' },
          intervalMinutes: { type: 'number', description: 'Run interval in minutes (default: 5)' },
          alertWhen: { type: 'string', description: 'Alert condition: exitCode, outputContains, outputChanges' },
          match: { type: 'string', description: 'String to match (for outputContains mode)' },
        },
        required: ['id', 'command'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const id = args['id'] as string;
      const command = args['command'] as string;
      const intervalMinutes = (args['intervalMinutes'] as number) || 5;
      const alertWhen = (args['alertWhen'] as AlertWhen) || 'exitCode';
      const match = args['match'] as string | undefined;

      // Stop existing monitor
      const existing = monitors.get(id);
      if (existing) {
        clearInterval(existing.timer);
        monitors.delete(id);
      }

      // Parse command into executable and args
      const parts = command.split(' ');
      const executable = parts[0]!;
      const cmdArgs = parts.slice(1);

      const entry: CommandMonitor = {
        command: executable,
        args: cmdArgs,
        intervalMs: intervalMinutes * 60 * 1000,
        alertWhen,
        match,
        timer: null as unknown as ReturnType<typeof setInterval>,
      };

      // Initial run
      const initial = await runCommand(entry);
      entry.lastOutput = initial.stdout;
      entry.lastExitCode = initial.exitCode;

      const initialAlert = checkAlert(entry, initial.stdout, initial.exitCode);

      // Start periodic monitoring
      entry.timer = setInterval(async () => {
        const result = await runCommand(entry);
        const alert = checkAlert(entry, result.stdout, result.exitCode);

        if (alert) {
          commandAlerts.push({
            id,
            command,
            reason: alert,
            output: result.stdout.slice(0, 500),
            timestamp: Date.now(),
          });
          if (alertSender) {
            alertSender(`Command monitor '${id}': ${alert}`).catch(() => { /* best-effort */ });
          }
        }

        entry.lastOutput = result.stdout;
        entry.lastExitCode = result.exitCode;
      }, entry.intervalMs);

      monitors.set(id, entry);

      return JSON.stringify({
        monitoring: true,
        id,
        command,
        alertWhen,
        intervalMinutes,
        initialExitCode: initial.exitCode,
        initialAlert: initialAlert ?? 'none',
      });
    },
  },
  {
    definition: {
      name: 'stop_monitor_command',
      description: 'Stop a command monitor',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Monitor ID to stop' },
        },
        required: ['id'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const id = args['id'] as string;
      const entry = monitors.get(id);
      if (!entry) return `No monitor with ID '${id}'`;
      clearInterval(entry.timer);
      monitors.delete(id);
      return `Stopped monitor '${id}'`;
    },
  },
  {
    definition: {
      name: 'list_command_monitors',
      description: 'List active command monitors and recent alerts',
      parameters: { type: 'object', properties: {} },
    },
    async execute(): Promise<string> {
      const active = Array.from(monitors.entries()).map(([id, entry]) => ({
        id,
        command: `${entry.command} ${entry.args.join(' ')}`.trim(),
        alertWhen: entry.alertWhen,
        lastExitCode: entry.lastExitCode,
      }));

      const recent = commandAlerts.slice(-10);

      return JSON.stringify({ activeMonitors: active, recentAlerts: recent }, null, 2);
    },
  },
];

export async function onUnload(): Promise<void> {
  for (const [, entry] of monitors) {
    clearInterval(entry.timer);
  }
  monitors.clear();
}
