import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { TranscriptEntry } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('sessions:transcript');

export class TranscriptManager {
  private baseDir: string;

  constructor(agentId: string) {
    this.baseDir = path.join(os.homedir(), '.agentx', 'agents', agentId, 'sessions');
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getFilePath(sessionId: string, threadId?: string): string {
    const name = threadId
      ? `${sessionId}-topic-${threadId}.jsonl`
      : `${sessionId}.jsonl`;
    return path.join(this.baseDir, name);
  }

  async append(sessionId: string, entry: TranscriptEntry, threadId?: string): Promise<void> {
    const filePath = this.getFilePath(sessionId, threadId);
    const line = JSON.stringify(entry) + '\n';

    try {
      fs.appendFileSync(filePath, line, 'utf-8');
    } catch (error) {
      log.error({ sessionId, error: error instanceof Error ? error.message : String(error) }, 'Failed to append transcript');
    }
  }

  async read(sessionId: string, threadId?: string): Promise<TranscriptEntry[]> {
    const filePath = this.getFilePath(sessionId, threadId);

    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as TranscriptEntry);
    } catch (error) {
      log.error({ sessionId, error: error instanceof Error ? error.message : String(error) }, 'Failed to read transcript');
      return [];
    }
  }

  async getRecent(sessionId: string, limit: number, threadId?: string): Promise<TranscriptEntry[]> {
    const entries = await this.read(sessionId, threadId);
    return entries.slice(-limit);
  }

  async delete(sessionId: string, threadId?: string): Promise<void> {
    const filePath = this.getFilePath(sessionId, threadId);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log.info({ sessionId }, 'Transcript deleted');
    }
  }

  async getTokenCount(sessionId: string, threadId?: string): Promise<number> {
    const entries = await this.read(sessionId, threadId);
    return entries.reduce((sum, e) => sum + (e.metadata?.tokens ?? 0), 0);
  }

  getBaseDir(): string {
    return this.baseDir;
  }
}
