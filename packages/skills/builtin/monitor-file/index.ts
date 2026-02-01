/**
 * Monitor File Skill
 *
 * Watch files and directories for changes using polling.
 * Tracks change, add, and unlink events.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface WatchEntry {
  path: string;
  events: string[];
  timer: ReturnType<typeof setInterval>;
  snapshot: Map<string, { mtime: number; size: number }>;
}

const watchers = new Map<string, WatchEntry>();
const fileAlerts: Array<{ path: string; event: string; file: string; timestamp: number }> = [];

/** Optional callback to send alerts through HeartbeatManager or other notification channel. */
export type AlertSender = (message: string) => Promise<void>;
let alertSender: AlertSender | null = null;

export function setAlertSender(sender: AlertSender): void {
  alertSender = sender;
}

function takeSnapshot(watchPath: string): Map<string, { mtime: number; size: number }> {
  const snapshot = new Map<string, { mtime: number; size: number }>();

  try {
    const stat = fs.statSync(watchPath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(watchPath);
      for (const entry of entries) {
        try {
          const fullPath = path.join(watchPath, entry);
          const s = fs.statSync(fullPath);
          snapshot.set(entry, { mtime: s.mtimeMs, size: s.size });
        } catch {
          // Skip inaccessible files
        }
      }
    } else {
      snapshot.set(path.basename(watchPath), { mtime: stat.mtimeMs, size: stat.size });
    }
  } catch {
    // Path doesn't exist yet
  }

  return snapshot;
}

function diffSnapshots(
  oldSnap: Map<string, { mtime: number; size: number }>,
  newSnap: Map<string, { mtime: number; size: number }>,
): Array<{ event: 'change' | 'add' | 'unlink'; file: string }> {
  const events: Array<{ event: 'change' | 'add' | 'unlink'; file: string }> = [];

  // Check for additions and changes
  for (const [file, newInfo] of newSnap) {
    const oldInfo = oldSnap.get(file);
    if (!oldInfo) {
      events.push({ event: 'add', file });
    } else if (oldInfo.mtime !== newInfo.mtime || oldInfo.size !== newInfo.size) {
      events.push({ event: 'change', file });
    }
  }

  // Check for deletions
  for (const file of oldSnap.keys()) {
    if (!newSnap.has(file)) {
      events.push({ event: 'unlink', file });
    }
  }

  return events;
}

export const tools = [
  {
    definition: {
      name: 'monitor_file',
      description: 'Start watching a file or directory for changes',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory path to watch' },
          events: {
            type: 'array',
            items: { type: 'string' },
            description: 'Events to watch for: change, add, unlink (default: all)',
          },
          intervalSeconds: { type: 'number', description: 'Poll interval in seconds (default: 5)' },
        },
        required: ['path'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const watchPath = args['path'] as string;
      const events = (args['events'] as string[]) || ['change', 'add', 'unlink'];
      const intervalSeconds = (args['intervalSeconds'] as number) || 5;

      // Stop existing watcher for this path
      const existing = watchers.get(watchPath);
      if (existing) {
        clearInterval(existing.timer);
        watchers.delete(watchPath);
      }

      if (!fs.existsSync(watchPath)) {
        return `Path does not exist: ${watchPath}`;
      }

      const snapshot = takeSnapshot(watchPath);

      const entry: WatchEntry = {
        path: watchPath,
        events,
        snapshot,
        timer: setInterval(() => {
          const newSnapshot = takeSnapshot(watchPath);
          const diffs = diffSnapshots(entry.snapshot, newSnapshot);

          for (const diff of diffs) {
            if (events.includes(diff.event)) {
              const alert = { path: watchPath, event: diff.event, file: diff.file, timestamp: Date.now() };
              fileAlerts.push(alert);
              if (alertSender) {
                alertSender(`File ${diff.event}: ${diff.file} in ${watchPath}`).catch(() => { /* best-effort */ });
              }
            }
          }

          entry.snapshot = newSnapshot;
        }, intervalSeconds * 1000),
      };

      watchers.set(watchPath, entry);

      return JSON.stringify({
        watching: true,
        path: watchPath,
        events,
        intervalSeconds,
        filesTracked: snapshot.size,
      });
    },
  },
  {
    definition: {
      name: 'stop_monitor_file',
      description: 'Stop watching a file or directory',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to stop watching' },
        },
        required: ['path'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const watchPath = args['path'] as string;
      const entry = watchers.get(watchPath);
      if (!entry) return `Not watching ${watchPath}`;
      clearInterval(entry.timer);
      watchers.delete(watchPath);
      return `Stopped watching ${watchPath}`;
    },
  },
  {
    definition: {
      name: 'list_file_monitors',
      description: 'List active file monitors and recent file change alerts',
      parameters: { type: 'object', properties: {} },
    },
    async execute(): Promise<string> {
      const active = Array.from(watchers.entries()).map(([p, entry]) => ({
        path: p,
        events: entry.events,
        filesTracked: entry.snapshot.size,
      }));

      const recent = fileAlerts.slice(-20);

      return JSON.stringify({ activeWatchers: active, recentAlerts: recent }, null, 2);
    },
  },
];

export async function onUnload(): Promise<void> {
  for (const [, entry] of watchers) {
    clearInterval(entry.timer);
  }
  watchers.clear();
}
