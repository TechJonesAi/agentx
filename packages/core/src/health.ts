import * as http from 'node:http';
import { createLogger } from './logger.js';

const log = createLogger('health');

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  version: string;
  timestamp: string;
}

export interface HealthStats {
  activeSessions: number;
  messagesProcessed: number;
  lastActivity: number | null;
  memoryUsage: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
  };
  providers: Record<string, 'connected' | 'disconnected' | 'rate-limited' | 'unknown'>;
  circuitBreakers: Record<string, string>;
  rateLimiter: {
    pendingRequests: number;
    requestsInWindow: number;
  } | null;
}

type StatsProvider = () => HealthStats;

export interface HealthServerConfig {
  port: number;
  host: string;
  authToken?: string;
}

export class HealthServer {
  private server: http.Server | null = null;
  private config: HealthServerConfig;
  private startTime = Date.now();
  private statsProvider: StatsProvider | null = null;
  private version: string;

  constructor(config?: Partial<HealthServerConfig>, version = '0.1.0') {
    this.config = {
      port: config?.port ?? parseInt(process.env['HEALTH_PORT'] ?? '9090', 10),
      host: config?.host ?? '127.0.0.1', // localhost only by default
      authToken: config?.authToken ?? process.env['HEALTH_AUTH_TOKEN'],
    };
    this.version = version;
  }

  setStatsProvider(provider: StatsProvider): void {
    this.statsProvider = provider;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        log.info({
          port: this.config.port,
          host: this.config.host,
        }, 'Health server started');
        resolve();
      });

      this.server!.on('error', (error) => {
        log.error({ error: error.message }, 'Health server error');
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        log.info('Health server stopped');
        resolve();
      });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Auth check
    if (this.config.authToken) {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${this.config.authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    switch (url.pathname) {
      case '/health':
        this.handleHealth(res);
        break;
      case '/stats':
        this.handleStats(res);
        break;
      default:
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found', endpoints: ['/health', '/stats'] }));
    }
  }

  private handleHealth(res: http.ServerResponse): void {
    const health: HealthStatus = {
      status: 'healthy',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: this.version,
      timestamp: new Date().toISOString(),
    };

    // Check if any stats indicate degraded health
    if (this.statsProvider) {
      try {
        const stats = this.statsProvider();
        const mem = stats.memoryUsage;

        // Degraded if using > 90% of heap
        if (mem.heapTotalMB > 0 && mem.heapUsedMB / mem.heapTotalMB > 0.9) {
          health.status = 'degraded';
        }

        // Check if any providers are down
        const downProviders = Object.values(stats.providers).filter((s) => s === 'disconnected');
        if (downProviders.length > 0) {
          health.status = 'degraded';
        }
      } catch {
        health.status = 'degraded';
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health, null, 2));
  }

  private handleStats(res: http.ServerResponse): void {
    if (!this.statsProvider) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Stats not available' }));
      return;
    }

    try {
      const stats = this.statsProvider();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats, null, 2));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Failed to collect stats',
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  getPort(): number {
    return this.config.port;
  }

  isRunning(): boolean {
    return this.server !== null;
  }
}
