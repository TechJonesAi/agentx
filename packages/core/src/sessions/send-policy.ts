import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { InboundContext, SendPolicyConfig, SendPolicyRule } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('sessions:send-policy');

export class SendPolicyManager {
  private config: SendPolicyConfig;
  private overrides = new Map<string, 'allow' | 'deny'>();
  private persistPath: string | null = null;

  constructor(config: SendPolicyConfig, agentId?: string) {
    this.config = config;

    if (agentId) {
      this.persistPath = path.join(os.homedir(), '.agentx', 'agents', agentId, 'send-overrides.json');
      this.loadOverrides();
    }
  }

  private loadOverrides(): void {
    if (!this.persistPath) return;
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8')) as Record<string, 'allow' | 'deny'>;
        for (const [key, value] of Object.entries(data)) {
          this.overrides.set(key, value);
        }
      }
    } catch {
      // Ignore corrupt file
    }
  }

  private persistOverrides(): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: Record<string, 'allow' | 'deny'> = {};
      for (const [key, value] of this.overrides) {
        data[key] = value;
      }
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to persist send overrides');
    }
  }

  /**
   * Check whether a message can be sent for the given session + context.
   */
  canSend(sessionKey: string, context: InboundContext): boolean {
    // Per-session runtime override takes precedence
    const override = this.overrides.get(sessionKey);
    if (override) {
      return override === 'allow';
    }

    // Evaluate rules in order, first match wins
    for (const rule of this.config.rules) {
      if (this.matchesRule(rule, sessionKey, context)) {
        return rule.action === 'allow';
      }
    }

    // Default policy
    return this.config.default === 'allow';
  }

  private matchesRule(rule: SendPolicyRule, sessionKey: string, context: InboundContext): boolean {
    const match = rule.match;

    if (match.channel && match.channel !== context.provider) {
      return false;
    }

    if (match.chatType && match.chatType !== context.chatType) {
      return false;
    }

    if (match.keyPrefix && !sessionKey.startsWith(match.keyPrefix)) {
      return false;
    }

    return true;
  }

  /**
   * Handle runtime override commands: /send on, /send off, /send inherit.
   * Returns true if the command was recognized and handled.
   */
  handleOverrideCommand(sessionKey: string, command: string): boolean {
    const trimmed = command.trim().toLowerCase();

    if (!trimmed.startsWith('/send ')) {
      return false;
    }

    const arg = trimmed.slice(6).trim();

    switch (arg) {
      case 'on':
        this.overrides.set(sessionKey, 'allow');
        this.persistOverrides();
        log.info({ sessionKey, action: 'allow' }, 'Send policy overridden');
        return true;

      case 'off':
        this.overrides.set(sessionKey, 'deny');
        this.persistOverrides();
        log.info({ sessionKey, action: 'deny' }, 'Send policy overridden');
        return true;

      case 'inherit':
        this.overrides.delete(sessionKey);
        this.persistOverrides();
        log.info({ sessionKey }, 'Send policy override cleared');
        return true;

      default:
        return false;
    }
  }

  /**
   * Get the current effective policy for a session.
   */
  getEffectivePolicy(sessionKey: string, context: InboundContext): 'allow' | 'deny' {
    return this.canSend(sessionKey, context) ? 'allow' : 'deny';
  }

  getOverride(sessionKey: string): 'allow' | 'deny' | null {
    return this.overrides.get(sessionKey) ?? null;
  }

  clearAllOverrides(): void {
    this.overrides.clear();
    this.persistOverrides();
  }

  updateConfig(config: SendPolicyConfig): void {
    this.config = config;
  }
}
