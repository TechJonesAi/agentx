/**
 * Monitor Website Skill
 *
 * Periodically checks a URL and alerts when:
 * - The site goes down (status != 200)
 * - Content changes
 * - Content contains/no longer contains a specific string
 */

interface MonitorEntry {
  url: string;
  interval: number; // ms
  alertOn: 'down' | 'change' | 'contains' | 'not-contains';
  match?: string;
  lastStatus?: number;
  lastHash?: string;
  lastCheck?: number;
  timer?: ReturnType<typeof setInterval>;
}

const monitors = new Map<string, MonitorEntry>();
const alerts: Array<{ url: string; type: string; message: string; timestamp: number }> = [];

/** Optional callback to send alerts through HeartbeatManager or other notification channel. */
export type AlertSender = (message: string) => Promise<void>;
let alertSender: AlertSender | null = null;

export function setAlertSender(sender: AlertSender): void {
  alertSender = sender;
}

async function checkUrl(entry: MonitorEntry): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const response = await fetch(entry.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AgentX-Monitor/0.1' },
    });
    clearTimeout(timeout);

    const body = await response.text();
    const hash = simpleHash(body);
    const status = response.status;

    let alert: string | null = null;

    switch (entry.alertOn) {
      case 'down':
        if (status >= 400) {
          alert = `Site ${entry.url} returned HTTP ${status}`;
        } else if (entry.lastStatus && entry.lastStatus >= 400 && status < 400) {
          alert = `Site ${entry.url} is back up (HTTP ${status})`;
        }
        break;

      case 'change':
        if (entry.lastHash && entry.lastHash !== hash) {
          alert = `Content changed at ${entry.url}`;
        }
        break;

      case 'contains':
        if (entry.match && !body.includes(entry.match)) {
          alert = `"${entry.match}" no longer found at ${entry.url}`;
        }
        break;

      case 'not-contains':
        if (entry.match && body.includes(entry.match)) {
          alert = `"${entry.match}" was found at ${entry.url}`;
        }
        break;
    }

    entry.lastStatus = status;
    entry.lastHash = hash;
    entry.lastCheck = Date.now();

    return alert;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (entry.alertOn === 'down') {
      return `Site ${entry.url} is unreachable: ${msg}`;
    }
    return null;
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

export const tools = [
  {
    definition: {
      name: 'monitor_website',
      description: 'Start monitoring a website URL for availability or content changes',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to monitor' },
          intervalMinutes: { type: 'number', description: 'Check interval in minutes (default: 5)' },
          alertOn: { type: 'string', description: 'Alert condition: down, change, contains, not-contains' },
          match: { type: 'string', description: 'String to match (for contains/not-contains mode)' },
        },
        required: ['url'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const url = args['url'] as string;
      const intervalMinutes = (args['intervalMinutes'] as number) || 5;
      const alertOn = (args['alertOn'] as MonitorEntry['alertOn']) || 'down';
      const match = args['match'] as string | undefined;

      if (monitors.has(url)) {
        const existing = monitors.get(url)!;
        if (existing.timer) clearInterval(existing.timer);
        monitors.delete(url);
      }

      const entry: MonitorEntry = {
        url,
        interval: intervalMinutes * 60 * 1000,
        alertOn,
        match,
      };

      // Do initial check
      const initialAlert = await checkUrl(entry);

      // Start periodic monitoring
      entry.timer = setInterval(async () => {
        const alert = await checkUrl(entry);
        if (alert) {
          alerts.push({ url, type: alertOn, message: alert, timestamp: Date.now() });
          if (alertSender) {
            alertSender(alert).catch(() => { /* best-effort */ });
          }
        }
      }, entry.interval);

      monitors.set(url, entry);

      return JSON.stringify({
        monitoring: true,
        url,
        alertOn,
        intervalMinutes,
        initialStatus: entry.lastStatus ?? 'unknown',
        initialAlert: initialAlert ?? 'none',
      });
    },
  },
  {
    definition: {
      name: 'stop_monitor_website',
      description: 'Stop monitoring a website URL',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to stop monitoring' },
        },
        required: ['url'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const url = args['url'] as string;
      const entry = monitors.get(url);
      if (!entry) {
        return `Not monitoring ${url}`;
      }
      if (entry.timer) clearInterval(entry.timer);
      monitors.delete(url);
      return `Stopped monitoring ${url}`;
    },
  },
  {
    definition: {
      name: 'list_website_monitors',
      description: 'List all active website monitors and any recent alerts',
      parameters: { type: 'object', properties: {} },
    },
    async execute(): Promise<string> {
      const active = Array.from(monitors.entries()).map(([url, entry]) => ({
        url,
        alertOn: entry.alertOn,
        lastStatus: entry.lastStatus,
        lastCheck: entry.lastCheck ? new Date(entry.lastCheck).toISOString() : 'never',
      }));

      const recentAlerts = alerts.slice(-10);

      return JSON.stringify({ activeMonitors: active, recentAlerts }, null, 2);
    },
  },
];

export async function onUnload(): Promise<void> {
  for (const [, entry] of monitors) {
    if (entry.timer) clearInterval(entry.timer);
  }
  monitors.clear();
}
