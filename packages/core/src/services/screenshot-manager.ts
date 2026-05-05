/**
 * ScreenshotManager — Real implementation using macOS `screencapture`.
 *
 * Captures the screen to a PNG file and returns metadata including
 * dimensions, SHA-256 hash, and optional base64 encoding.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createLogger } from '../logger.js';

const log = createLogger('services:screenshot');

export interface ScreenshotResult {
  filePath: string;
  width: number;
  height: number;
  sha256: string;
  base64: string;
  createdAt: number;
}

export class RealScreenshotManager {
  private outputDir: string;

  constructor(outputDir?: string) {
    // Default location is the user's AgentX data dir — NEVER a world-readable
    // tmp location, because screenshots contain the user's screen (emails,
    // banking UI, passwords, private chats, etc.). Fall back to ~/.agentx
    // so the directory sits inside the user's home with restrictive mode.
    if (outputDir) {
      this.outputDir = outputDir;
    } else {
      const home = process.env['HOME'] ?? '';
      this.outputDir = home
        ? path.join(home, '.agentx', 'screenshots')
        : path.join(process.env['TMPDIR'] ?? '/tmp', 'agentx-screenshots');
    }
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true, mode: 0o700 });
    } else {
      // Tighten mode on any pre-existing directory that might have been
      // created under the looser /tmp-era default. chmod is a no-op when
      // the bits are already correct.
      try { fs.chmodSync(this.outputDir, 0o700); } catch { /* best effort */ }
    }
    log.info({ outputDir: this.outputDir }, 'ScreenshotManager initialized');
  }

  /**
   * Capture the current screen and return metadata.
   *
   * @param options.destPath  Optional absolute or tilde-prefixed path to save
   *   the screenshot to instead of the default temp directory. Parent
   *   directories are created automatically. Tilde is expanded to $HOME.
   */
  async capture(options: { destPath?: string } = {}): Promise<ScreenshotResult> {
    const timestamp = Date.now();
    let filePath: string;

    if (options.destPath) {
      // Expand leading tilde so LLMs can pass ~/Desktop/foo.png naturally.
      const home = process.env['HOME'] ?? '/tmp';
      let dest = options.destPath;
      if (dest === '~') dest = home;
      else if (dest.startsWith('~/')) dest = path.join(home, dest.slice(2));
      // Create parent directory if missing.
      const parent = path.dirname(dest);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
      filePath = dest;
    } else {
      filePath = path.join(this.outputDir, `screenshot_${timestamp}.png`);
    }

    try {
      // Use macOS screencapture (non-interactive, main display). Quoting the
      // path protects against spaces (e.g. ~/Desktop/agentx test folder/…).
      execSync(`screencapture -x -C "${filePath.replace(/"/g, '\\"')}"`, { timeout: 10000 });
    } catch (err) {
      log.error({ error: (err as Error).message }, 'screencapture failed');
      throw new Error(`Screenshot capture failed: ${(err as Error).message}`);
    }

    if (!fs.existsSync(filePath)) {
      throw new Error('Screenshot file was not created');
    }

    // Tighten permissions on the captured file so it's owner-only.
    // Best-effort: some filesystems (e.g. FAT on an external drive the
    // user asked to save to) don't honour chmod. That's acceptable —
    // the default path lives under ~/.agentx which does support it.
    try { fs.chmodSync(filePath, 0o600); } catch { /* */ }

    const buf = fs.readFileSync(filePath);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const base64 = buf.toString('base64');

    // Parse PNG dimensions from IHDR chunk (bytes 16-23)
    let width = 0;
    let height = 0;
    if (buf.length > 24) {
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    }

    log.info({ filePath, width, height }, 'Screenshot captured');

    return {
      filePath,
      width,
      height,
      sha256,
      base64,
      createdAt: timestamp,
    };
  }
}
