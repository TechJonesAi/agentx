/**
 * Forced Verification Rules — Deterministic tool execution enforcement.
 *
 * Phase 2 of P6-11 Hybrid Controller system.
 * The LLM must NOT be trusted to decide whether verification occurs.
 * This module enforces mandatory tool execution based on domain and confidence.
 *
 * Rules:
 * 1. Legal/medical/financial queries ALWAYS require cognitive_query + web_search
 * 2. If controller fails to include required tools → force them
 * 3. If controller confidence < threshold → force full verification
 * 4. Controller is advisory, NOT authoritative
 */

import { createLogger } from '../logger.js';
import type { ToolPlan, PlannedToolCall } from './tool-planner.js';
import type { ToolRegistry } from '../tools/index.js';

const log = createLogger('hybrid:forced-verification');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForcedVerificationResult {
  /** Final list of tools to execute (controller + forced) */
  toolsToExecute: PlannedToolCall[];
  /** Which tools were forced (not from controller) */
  forcedTools: string[];
  /** Which tools came from the controller plan */
  controllerTools: string[];
  /** Why verification was forced */
  forcedReasons: string[];
  /** Whether any forcing was applied */
  wasForced: boolean;
  /** The domain that triggered forcing */
  domain: string;
}

export interface VerificationRuleConfig {
  /** Domains that always require verification */
  mandatoryVerificationDomains: string[];
  /** Tools required for mandatory verification */
  requiredTools: string[];
  /** Confidence threshold below which forced verification applies */
  confidenceThreshold: number;
  /** Whether to force verification when controller returns no tools */
  forceOnEmptyPlan: boolean;
}

const DEFAULT_RULES: VerificationRuleConfig = {
  mandatoryVerificationDomains: ['legal', 'medical', 'financial'],
  requiredTools: ['cognitive_query', 'web_search'],
  confidenceThreshold: 0.6,
  forceOnEmptyPlan: true,
};

// ---------------------------------------------------------------------------
// Domain-Specific Tool Arguments
// ---------------------------------------------------------------------------

/**
 * Generate appropriate arguments for forced tools based on domain and query.
 */
function buildForcedToolArgs(
  tool: string,
  query: string,
  domain: string,
): Record<string, unknown> {
  switch (tool) {
    case 'cognitive_query':
      return { query };
    case 'web_search': {
      // For legal domain, add domain hint for authority
      const domainHint = domain === 'legal' ? 'legal'
        : domain === 'medical' ? 'medical'
          : domain === 'financial' ? 'financial'
            : undefined;
      const args: Record<string, unknown> = { query };
      if (domainHint) args['domain'] = domainHint;
      return args;
    }
    default:
      return { query };
  }
}

// ---------------------------------------------------------------------------
// ForcedVerificationEngine
// ---------------------------------------------------------------------------

export class ForcedVerificationEngine {
  private rules: VerificationRuleConfig;

  constructor(rules?: Partial<VerificationRuleConfig>) {
    this.rules = { ...DEFAULT_RULES, ...rules };
  }

  /**
   * Apply forced verification rules to a controller's tool plan.
   * Returns the final set of tools to execute — controller plan + forced tools.
   */
  enforce(
    plan: ToolPlan,
    query: string,
    domain: string,
  ): ForcedVerificationResult {
    const forcedTools: string[] = [];
    const forcedReasons: string[] = [];
    const controllerTools = plan.tools.map(t => t.tool);
    const allTools: PlannedToolCall[] = [...plan.tools];

    const isMandatoryDomain = this.rules.mandatoryVerificationDomains.includes(domain);

    // RULE 1: Mandatory domain verification
    if (isMandatoryDomain) {
      for (const required of this.rules.requiredTools) {
        if (!controllerTools.includes(required)) {
          allTools.push({
            tool: required,
            arguments: buildForcedToolArgs(required, query, domain),
            reason: `FORCED: ${domain} domain requires ${required}`,
          });
          forcedTools.push(required);
          forcedReasons.push(`Domain "${domain}" mandates ${required} execution`);
          log.info({ tool: required, domain }, 'Forced tool execution — mandatory domain verification');
        }
      }
    }

    // RULE 2: Controller confidence below threshold
    if (plan.confidence < this.rules.confidenceThreshold && !isMandatoryDomain) {
      for (const required of this.rules.requiredTools) {
        if (!controllerTools.includes(required) && !forcedTools.includes(required)) {
          allTools.push({
            tool: required,
            arguments: buildForcedToolArgs(required, query, domain),
            reason: `FORCED: controller confidence (${plan.confidence.toFixed(2)}) below threshold (${this.rules.confidenceThreshold})`,
          });
          forcedTools.push(required);
          forcedReasons.push(`Low controller confidence (${plan.confidence.toFixed(2)}) triggered forced verification`);
          log.info({ tool: required, confidence: plan.confidence }, 'Forced tool execution — low confidence');
        }
      }
    }

    // RULE 3: Empty plan + non-trivial query
    if (this.rules.forceOnEmptyPlan && plan.tools.length === 0 && isMandatoryDomain) {
      for (const required of this.rules.requiredTools) {
        if (!forcedTools.includes(required)) {
          allTools.push({
            tool: required,
            arguments: buildForcedToolArgs(required, query, domain),
            reason: 'FORCED: empty controller plan for mandatory-verification domain',
          });
          forcedTools.push(required);
          forcedReasons.push('Controller returned no tools for mandatory-verification domain');
          log.info({ tool: required, domain }, 'Forced tool execution — empty plan for mandatory domain');
        }
      }
    }

    const wasForced = forcedTools.length > 0;

    if (wasForced) {
      log.info({
        domain,
        controllerTools,
        forcedTools,
        totalTools: allTools.length,
        confidence: plan.confidence,
      }, 'Verification enforcement applied');
    }

    return {
      toolsToExecute: allTools,
      forcedTools,
      controllerTools,
      forcedReasons,
      wasForced,
      domain,
    };
  }

  /**
   * Execute the forced/planned tools and return raw results.
   */
  async executeTools(
    verification: ForcedVerificationResult,
    toolRegistry: ToolRegistry,
    sessionId: string,
    agent: any,
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    // Execute in sequence order
    for (const planned of verification.toolsToExecute) {
      try {
        const result = await toolRegistry.execute(planned.tool, planned.arguments, {
          sessionId,
          agent,
        });
        results.set(planned.tool, result);
        log.debug({ tool: planned.tool, resultLength: result.length }, 'Tool executed');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        results.set(planned.tool, `Error: ${errMsg}`);
        log.warn({ tool: planned.tool, error: errMsg }, 'Tool execution failed');
      }
    }

    return results;
  }

  getRules(): VerificationRuleConfig {
    return { ...this.rules };
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      mandatoryDomains: this.rules.mandatoryVerificationDomains,
      requiredTools: this.rules.requiredTools,
      confidenceThreshold: this.rules.confidenceThreshold,
      forceOnEmptyPlan: this.rules.forceOnEmptyPlan,
    };
  }
}
