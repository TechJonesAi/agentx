/**
 * ComputerPermissionService — Real implementation with default-DENY policy.
 *
 * Every computer action category starts DENIED. Users must explicitly grant
 * permission via the API before any action in that category can execute.
 */

import { v4 as uuid } from 'uuid';
import { createLogger } from '../logger.js';

const log = createLogger('services:computer-permission');

export type PermissionCategory =
  | 'mouse'
  | 'keyboard'
  | 'screenshot'
  | 'screen_info'
  | 'app_control'
  | 'terminal';

export type PermissionDecision = 'allow' | 'deny';

export interface PermissionRule {
  id: string;
  category: PermissionCategory;
  scope: Record<string, unknown>;
  decision: PermissionDecision;
  createdAt: number;
  updatedAt: number;
}

export interface GrantInput {
  category: PermissionCategory;
  scope?: Record<string, unknown>;
  decision?: PermissionDecision;
}

export interface UpdateInput {
  decision?: PermissionDecision;
  scope?: Record<string, unknown>;
}

/**
 * Default-DENY permission service for computer control.
 * No action is allowed unless an explicit ALLOW rule exists.
 */
export class RealComputerPermissionService {
  private rules = new Map<string, PermissionRule>();

  constructor() {
    log.info('ComputerPermissionService initialized with DEFAULT-DENY policy');
  }

  /**
   * Check whether an action in the given category is allowed.
   * Returns false (DENY) unless an explicit allow rule exists.
   */
  check(action: string): boolean {
    const category = this.actionToCategory(action);
    if (!category) {
      log.warn({ action }, 'Unknown action — denied by default');
      return false;
    }
    for (const rule of this.rules.values()) {
      if (rule.category === category && rule.decision === 'allow') {
        return true;
      }
    }
    log.debug({ action, category }, 'No allow rule found — denied');
    return false;
  }

  /** List all rules, optionally filtered by category. */
  list(category?: PermissionCategory): PermissionRule[] {
    const all = Array.from(this.rules.values());
    if (!category) return all;
    return all.filter((r) => r.category === category);
  }

  /** Grant (create) a new permission rule. */
  grant(input: GrantInput): PermissionRule {
    const now = Date.now();
    const rule: PermissionRule = {
      id: uuid(),
      category: input.category,
      scope: input.scope ?? {},
      decision: input.decision ?? 'allow',
      createdAt: now,
      updatedAt: now,
    };
    this.rules.set(rule.id, rule);
    log.info({ ruleId: rule.id, category: rule.category, decision: rule.decision }, 'Permission rule created');
    return rule;
  }

  /** Update an existing rule. */
  update(ruleId: string, changes: UpdateInput): PermissionRule | null {
    const rule = this.rules.get(ruleId);
    if (!rule) return null;
    if (changes.decision !== undefined) rule.decision = changes.decision;
    if (changes.scope !== undefined) rule.scope = changes.scope;
    rule.updatedAt = Date.now();
    log.info({ ruleId, changes }, 'Permission rule updated');
    return rule;
  }

  /** Revoke (delete) a rule. Returns true if found. */
  revoke(ruleId: string): boolean {
    const deleted = this.rules.delete(ruleId);
    if (deleted) log.info({ ruleId }, 'Permission rule revoked');
    return deleted;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private actionToCategory(action: string): PermissionCategory | null {
    if (action.startsWith('computer_mouse')) return 'mouse';
    if (action.startsWith('computer_keyboard')) return 'keyboard';
    if (action === 'computer_screenshot') return 'screenshot';
    if (action === 'computer_screen_dimensions') return 'screen_info';
    if (action.startsWith('computer_app')) return 'app_control';
    if (action === 'computer_terminal_command') return 'terminal';
    return null;
  }
}
