import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { createLogger } from '../logger.js';

const execAsync = promisify(exec);
const log = createLogger('security:sandbox');

// ─── Permission Levels ───────────────────────────────────────────────────────

export type ShellPermissionLevel = 'unrestricted' | 'ask-confirm' | 'allowlist-only' | 'disabled';

export interface ShellSandboxConfig {
  permissionLevel: ShellPermissionLevel;
  allowedCommands: string[];
  blockedCommands: string[];
  blockedPatterns: RegExp[];
  allowedDirectories: string[];
  maxTimeout: number;
  maxOutputSize: number;
  confirmCallback?: (command: string) => Promise<boolean>;
}

const DEFAULT_BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf *',
  'mkfs',
  'dd if=/dev',
  ':(){:|:&};:',  // fork bomb
  'chmod -R 777 /',
  'chown -R',
  '> /dev/sda',
  'wget', // without allowlist these can pull arbitrary code
  'curl', // same concern
];

const DEFAULT_BLOCKED_PATTERNS = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/($|\s)/,       // rm -rf /
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?~($|\s)/,         // rm -rf ~
  />\s*\/dev\/[a-z]+/,                                 // overwrite devices
  /mkfs\./,                                             // format filesystem
  /dd\s+if=\/dev/,                                      // raw disk write
  /:()\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,           // fork bomb
  /chmod\s+(-R\s+)?777\s+\//,                          // recursive 777 on root
  /\|\s*sh($|\s)/,                                      // pipe to shell
  /\|\s*bash($|\s)/,                                    // pipe to bash
  /eval\s+/,                                            // eval
  /\bsudo\b/,                                           // sudo (without explicit allow)
  /\bsu\s+-?\s*$/,                                      // su to root
];

const DEFAULT_ALLOWED_COMMANDS = [
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc',
  'echo', 'date', 'whoami', 'pwd', 'which', 'env',
  'node', 'npm', 'npx', 'pnpm', 'yarn',
  'python', 'python3', 'pip', 'pip3',
  'git', 'gh',
  'mkdir', 'touch', 'cp', 'mv',
  'curl', 'wget',  // can be enabled in allowlist mode
  'jq', 'sed', 'awk', 'sort', 'uniq', 'cut',
  'tar', 'zip', 'unzip', 'gzip', 'gunzip',
];

// ─── Shell Sandbox ───────────────────────────────────────────────────────────

export class ShellSandbox {
  private config: ShellSandboxConfig;

  constructor(config?: Partial<ShellSandboxConfig>) {
    this.config = {
      permissionLevel: config?.permissionLevel ?? 'ask-confirm',
      allowedCommands: config?.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS,
      blockedCommands: config?.blockedCommands ?? DEFAULT_BLOCKED_COMMANDS,
      blockedPatterns: config?.blockedPatterns ?? DEFAULT_BLOCKED_PATTERNS,
      allowedDirectories: config?.allowedDirectories ?? [],
      maxTimeout: config?.maxTimeout ?? 30000,
      maxOutputSize: config?.maxOutputSize ?? 1024 * 1024,
      confirmCallback: config?.confirmCallback,
    };
  }

  async execute(command: string, workingDir?: string): Promise<ShellResult> {
    const validation = this.validateCommand(command, workingDir);
    if (!validation.allowed) {
      log.warn({ command, reason: validation.reason }, 'Command blocked');
      return {
        allowed: false,
        reason: validation.reason!,
        stdout: '',
        stderr: '',
        exitCode: -1,
      };
    }

    // Ask-confirm level: requires callback approval
    if (this.config.permissionLevel === 'ask-confirm' && this.config.confirmCallback) {
      const approved = await this.config.confirmCallback(command);
      if (!approved) {
        log.info({ command }, 'Command rejected by user');
        return {
          allowed: false,
          reason: 'User rejected command',
          stdout: '',
          stderr: '',
          exitCode: -1,
        };
      }
    }

    log.info({ command, workingDir }, 'Executing shell command');

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: this.config.maxTimeout,
        maxBuffer: this.config.maxOutputSize,
        cwd: workingDir,
        env: {
          ...process.env,
          // Prevent commands from reading credential env vars
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          TELEGRAM_BOT_TOKEN: undefined,
          DISCORD_BOT_TOKEN: undefined,
          SLACK_BOT_TOKEN: undefined,
          ELEVENLABS_API_KEY: undefined,
        },
      });

      return {
        allowed: true,
        stdout: stdout.slice(0, this.config.maxOutputSize),
        stderr: stderr.slice(0, this.config.maxOutputSize),
        exitCode: 0,
      };
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        allowed: true,
        stdout: execError.stdout?.slice(0, this.config.maxOutputSize) ?? '',
        stderr: execError.stderr?.slice(0, this.config.maxOutputSize) ?? '',
        exitCode: execError.code ?? 1,
        error: execError.message,
      };
    }
  }

  validateCommand(command: string, workingDir?: string): CommandValidation {
    // Disabled: block everything
    if (this.config.permissionLevel === 'disabled') {
      return { allowed: false, reason: 'Shell execution is disabled' };
    }

    // Check blocked patterns (applies to all permission levels)
    for (const pattern of this.config.blockedPatterns) {
      if (pattern.test(command)) {
        return { allowed: false, reason: `Command matches blocked pattern: ${pattern.source}` };
      }
    }

    // Check blocked commands (substring match)
    for (const blocked of this.config.blockedCommands) {
      if (command.includes(blocked)) {
        return { allowed: false, reason: `Command contains blocked substring: ${blocked}` };
      }
    }

    // Allowlist mode: only allowed base commands
    if (this.config.permissionLevel === 'allowlist-only') {
      const baseCommand = this.extractBaseCommand(command);
      if (!this.config.allowedCommands.includes(baseCommand)) {
        return { allowed: false, reason: `Command '${baseCommand}' not in allowlist` };
      }
    }

    // Directory restrictions
    if (this.config.allowedDirectories.length > 0 && workingDir) {
      const resolved = path.resolve(workingDir);
      const inAllowed = this.config.allowedDirectories.some((dir) =>
        resolved.startsWith(path.resolve(dir)),
      );
      if (!inAllowed) {
        return { allowed: false, reason: `Working directory '${resolved}' not in allowed directories` };
      }
    }

    return { allowed: true };
  }

  private extractBaseCommand(command: string): string {
    // Handle pipes and chains - validate each part
    const parts = command.split(/[|;&]/);
    const firstPart = parts[0]!.trim();
    // Extract the command name (handle paths like /usr/bin/ls)
    const tokens = firstPart.split(/\s+/);
    const cmd = tokens[0] ?? '';
    return path.basename(cmd);
  }

  getConfig(): ShellSandboxConfig {
    return { ...this.config };
  }

  setPermissionLevel(level: ShellPermissionLevel): void {
    this.config.permissionLevel = level;
  }

  addToAllowlist(command: string): void {
    if (!this.config.allowedCommands.includes(command)) {
      this.config.allowedCommands.push(command);
    }
  }

  addToBlocklist(command: string): void {
    if (!this.config.blockedCommands.includes(command)) {
      this.config.blockedCommands.push(command);
    }
  }

  addAllowedDirectory(dir: string): void {
    this.config.allowedDirectories.push(path.resolve(dir));
  }
}

export interface ShellResult {
  allowed: boolean;
  reason?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

interface CommandValidation {
  allowed: boolean;
  reason?: string;
}
