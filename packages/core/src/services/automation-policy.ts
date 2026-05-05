/**
 * AutomationPolicyService — Real implementation.
 *
 * Policies define what a runbook is allowed to do: which tools, commands,
 * apps, filesystem access, and safety limits. Default-safe: no filesystem
 * writes, no network, no unsafe terminal, root scope required.
 */

import { v4 as uuid } from 'uuid';
import { createLogger } from '../logger.js';

const log = createLogger('services:automation-policy');

export interface PolicyConfig {
  name: string;
  description?: string;
  allowedCategories?: string[];
  allowedTools?: string[];
  allowedCommands?: string[];
  allowedApps?: string[];
  maxSteps?: number;
  maxRuntimeMinutes?: number;
  allowNetwork?: boolean;
  allowFilesystemWrite?: boolean;
  allowTerminalUnsafe?: boolean;
  requireRootScope?: boolean;
  modelOverride?: string;
}

export interface AutomationPolicy {
  id: string;
  name: string;
  description: string;
  allowedCategories: string[];
  allowedTools: string[];
  allowedCommands: string[];
  allowedApps: string[];
  maxSteps: number;
  maxRuntimeMinutes: number;
  allowNetwork: boolean;
  allowFilesystemWrite: boolean;
  allowTerminalUnsafe: boolean;
  requireRootScope: boolean;
  modelOverride?: string;
  createdAt: number;
  updatedAt: number;
}

export class RealAutomationPolicyService {
  private policies = new Map<string, AutomationPolicy>();

  constructor() {
    log.info('AutomationPolicyService initialized (default-safe)');
  }

  /** List all policies, optionally filtered by allowed category. */
  list(categoryFilter?: string): AutomationPolicy[] {
    const all = Array.from(this.policies.values());
    if (!categoryFilter) return all;
    return all.filter((p) => p.allowedCategories.includes(categoryFilter));
  }

  /** Create a new policy with safe defaults. */
  create(config: PolicyConfig): AutomationPolicy {
    const now = Date.now();
    const policy: AutomationPolicy = {
      id: uuid(),
      name: config.name,
      description: config.description ?? '',
      allowedCategories: config.allowedCategories ?? [],
      allowedTools: config.allowedTools ?? ['shell', 'current_time'],
      allowedCommands: config.allowedCommands ?? [],
      allowedApps: config.allowedApps ?? [],
      maxSteps: config.maxSteps ?? 20,
      maxRuntimeMinutes: config.maxRuntimeMinutes ?? 10,
      allowNetwork: config.allowNetwork ?? false,
      allowFilesystemWrite: config.allowFilesystemWrite ?? false,
      allowTerminalUnsafe: config.allowTerminalUnsafe ?? false,
      requireRootScope: config.requireRootScope ?? true,
      modelOverride: config.modelOverride,
      createdAt: now,
      updatedAt: now,
    };
    this.policies.set(policy.id, policy);
    log.info({ policyId: policy.id, name: policy.name }, 'Policy created');
    return policy;
  }

  /** Get a policy by ID. */
  get(id: string): AutomationPolicy | null {
    return this.policies.get(id) ?? null;
  }

  /** Update an existing policy. */
  update(id: string, changes: Partial<PolicyConfig>): AutomationPolicy | null {
    const policy = this.policies.get(id);
    if (!policy) return null;
    if (changes.name !== undefined) policy.name = changes.name;
    if (changes.description !== undefined) policy.description = changes.description;
    if (changes.allowedCategories !== undefined) policy.allowedCategories = changes.allowedCategories;
    if (changes.allowedTools !== undefined) policy.allowedTools = changes.allowedTools;
    if (changes.allowedCommands !== undefined) policy.allowedCommands = changes.allowedCommands;
    if (changes.allowedApps !== undefined) policy.allowedApps = changes.allowedApps;
    if (changes.maxSteps !== undefined) policy.maxSteps = changes.maxSteps;
    if (changes.maxRuntimeMinutes !== undefined) policy.maxRuntimeMinutes = changes.maxRuntimeMinutes;
    if (changes.allowNetwork !== undefined) policy.allowNetwork = changes.allowNetwork;
    if (changes.allowFilesystemWrite !== undefined) policy.allowFilesystemWrite = changes.allowFilesystemWrite;
    if (changes.allowTerminalUnsafe !== undefined) policy.allowTerminalUnsafe = changes.allowTerminalUnsafe;
    if (changes.requireRootScope !== undefined) policy.requireRootScope = changes.requireRootScope;
    if (changes.modelOverride !== undefined) policy.modelOverride = changes.modelOverride;
    policy.updatedAt = Date.now();
    log.info({ policyId: id, changes: Object.keys(changes) }, 'Policy updated');
    return policy;
  }

  /** Delete a policy. */
  delete(id: string): boolean {
    const deleted = this.policies.delete(id);
    if (deleted) log.info({ policyId: id }, 'Policy deleted');
    return deleted;
  }

  /** Evaluate whether an action is allowed by a specific policy. */
  evaluate(action: string, policyId?: string): { allowed: boolean; reason?: string } {
    if (!policyId) {
      return { allowed: false, reason: 'No policy specified' };
    }
    const policy = this.policies.get(policyId);
    if (!policy) {
      return { allowed: false, reason: `Policy ${policyId} not found` };
    }
    // Check if the action/tool is in the allowed list
    if (policy.allowedTools.length > 0 && !policy.allowedTools.includes(action)) {
      return { allowed: false, reason: `Tool '${action}' not in policy allowed list` };
    }
    return { allowed: true };
  }
}
