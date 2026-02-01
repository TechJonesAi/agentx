import type { SessionEntry, ResetPolicy, SessionResetConfig } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('sessions:reset');

export interface ResetTriggerResult {
  isReset: boolean;
  newModel?: string;
  remainder: string;
}

export class SessionResetManager {
  private config: SessionResetConfig;

  constructor(config: SessionResetConfig) {
    this.config = config;
  }

  /**
   * Check if a session should be auto-reset based on its policy.
   */
  shouldReset(entry: SessionEntry, chatType: 'dm' | 'group' | 'thread', channel: string): boolean {
    const policy = this.getPolicy(chatType, channel);

    switch (policy.mode) {
      case 'never':
        return false;

      case 'daily': {
        const lastUpdate = new Date(entry.updatedAt);
        const now = new Date();
        const atHour = policy.atHour ?? 4;

        // Check if a daily boundary has been crossed
        const resetToday = new Date(now);
        resetToday.setHours(atHour, 0, 0, 0);

        // If last update was before today's reset hour and now is after, reset
        if (lastUpdate < resetToday && now >= resetToday) {
          return true;
        }

        // Also check idle timeout as a secondary trigger
        if (policy.idleMinutes) {
          const idleSince = now.getTime() - new Date(entry.updatedAt).getTime();
          if (idleSince > policy.idleMinutes * 60 * 1000) {
            return true;
          }
        }

        return false;
      }

      case 'idle': {
        if (!policy.idleMinutes) return false;
        const idleSince = Date.now() - new Date(entry.updatedAt).getTime();
        return idleSince > policy.idleMinutes * 60 * 1000;
      }

      default:
        return false;
    }
  }

  /**
   * Parse a message for reset trigger commands like /new or /reset.
   */
  parseResetTrigger(message: string): ResetTriggerResult {
    const trimmed = message.trim();

    for (const trigger of this.config.resetTriggers) {
      if (trimmed === trigger) {
        return { isReset: true, remainder: '' };
      }

      // Support `/new model-name` syntax
      if (trimmed.startsWith(trigger + ' ')) {
        const afterTrigger = trimmed.slice(trigger.length + 1).trim();
        // Check if the first word looks like a model name
        const parts = afterTrigger.split(/\s+/);
        const firstWord = parts[0] ?? '';

        // Model names typically contain dashes or dots (claude-3-opus, gpt-4o, etc.)
        if (firstWord.includes('-') || firstWord.includes('.') || firstWord.match(/^[a-z]+\d/)) {
          return {
            isReset: true,
            newModel: firstWord,
            remainder: parts.slice(1).join(' '),
          };
        }

        // Otherwise treat the whole remainder as a message after reset
        return { isReset: true, remainder: afterTrigger };
      }
    }

    return { isReset: false, remainder: message };
  }

  /**
   * Get the applicable reset policy for a given session type and channel.
   */
  getPolicy(chatType: 'dm' | 'group' | 'thread', channel: string): ResetPolicy {
    // Channel-specific override takes precedence
    if (this.config.resetByChannel?.[channel]) {
      return this.config.resetByChannel[channel];
    }

    // Type-specific override
    if (this.config.resetByType?.[chatType]) {
      return this.config.resetByType[chatType];
    }

    // Default policy
    return this.config.reset;
  }

  updateConfig(config: SessionResetConfig): void {
    this.config = config;
  }
}
