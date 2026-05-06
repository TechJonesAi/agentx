/**
 * Tool Planner — Controller model plans tool usage deterministically.
 *
 * Phase 1 of P6-11 Hybrid Controller system.
 * Uses the controller model (qwen2.5-coder:32b) to produce a ToolPlan
 * describing which tools to call, with what arguments, and in what order.
 *
 * The plan is ADVISORY — the system enforces forced verification rules
 * on top of whatever the controller suggests.
 */

import { createLogger } from '../logger.js';
import type { ModelFabric } from '../llm/model-fabric.js';
import type { ToolDefinition, Message } from '../types.js';

const log = createLogger('hybrid:tool-planner');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlannedToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface ToolPlan {
  tools: PlannedToolCall[];
  arguments: Record<string, Record<string, unknown>>;
  sequence: string[];
  confidence: number;
  controllerModel: string;
  planningLatencyMs: number;
}

export interface ToolPlannerConfig {
  /** Model to use for tool planning */
  controllerModel: string;
  /** Confidence threshold below which forced rules take over */
  confidenceThreshold: number;
  /** Maximum time to wait for controller planning */
  planningTimeoutMs: number;
}

const DEFAULT_CONFIG: ToolPlannerConfig = {
  controllerModel: 'qwen2.5-coder:32b',
  confidenceThreshold: 0.6,
  planningTimeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// ToolPlanner
// ---------------------------------------------------------------------------

export class ToolPlanner {
  private config: ToolPlannerConfig;
  private fabric: ModelFabric | null = null;

  constructor(config?: Partial<ToolPlannerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setModelFabric(fabric: ModelFabric): void {
    this.fabric = fabric;
    log.info({ model: this.config.controllerModel }, 'ToolPlanner wired to ModelFabric');
  }

  /**
   * Ask the controller model to plan which tools to use for the given query.
   * Returns a structured ToolPlan.
   */
  async plan(
    query: string,
    availableTools: ToolDefinition[],
    domain: string,
    knowledgeSummary: string,
  ): Promise<ToolPlan> {
    if (!this.fabric) {
      log.warn('No ModelFabric — returning empty plan');
      return this.emptyPlan();
    }

    const start = Date.now();

    const toolList = availableTools.map(t =>
      `- ${t.name}: ${t.description} (params: ${Object.keys(t.parameters?.properties ?? {}).join(', ')})`
    ).join('\n');

    const systemPrompt = [
      'You are a tool-planning controller. Your ONLY job is to decide which tools to call and with what arguments.',
      'You must respond in STRICT JSON format. No explanation, no markdown, just JSON.',
      '',
      'Available tools:',
      toolList,
      '',
      `Detected domain: ${domain}`,
      '',
      knowledgeSummary ? `Available knowledge: ${knowledgeSummary}` : 'No knowledge available from memory.',
      '',
      'Respond with this exact JSON structure:',
      '{',
      '  "tools": [{"tool": "tool_name", "arguments": {...}, "reason": "why"}],',
      '  "sequence": ["tool_name1", "tool_name2"],',
      '  "confidence": 0.0 to 1.0',
      '}',
      '',
      'Rules:',
      '- If the query requires current/external information, include web_search',
      '- If the query involves stored documents/emails, include cognitive_query',
      '- If domain is legal/medical/financial, ALWAYS include both cognitive_query AND web_search',
      '- If the query is a simple greeting or math, set tools to [] and confidence to 1.0',
      '- confidence reflects how certain you are about the tool plan',
    ].join('\n');

    const messages: Message[] = [
      { role: 'user', content: query, timestamp: Date.now() },
    ];

    try {
      const response = await this.fabric.completeWithMessages(
        { messages, systemPrompt },
        'code',  // Route to controller-capable models
        'tool-planning',
        this.config.controllerModel,
      );

      const latencyMs = Date.now() - start;
      const plan = this.parsePlan(response.content, latencyMs);

      log.info({
        tools: plan.sequence,
        confidence: plan.confidence,
        latencyMs: plan.planningLatencyMs,
        model: this.config.controllerModel,
      }, 'Tool plan generated');

      return plan;
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Controller planning failed — returning empty plan');
      return this.emptyPlan(Date.now() - start);
    }
  }

  /**
   * Parse the controller's JSON response into a ToolPlan.
   */
  private parsePlan(content: string, latencyMs: number): ToolPlan {
    try {
      // Extract JSON from response (may have markdown fences)
      let jsonStr = content.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }
      // Also try to find bare JSON object
      const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        jsonStr = braceMatch[0];
      }

      const parsed = JSON.parse(jsonStr);

      const tools: PlannedToolCall[] = Array.isArray(parsed.tools)
        ? parsed.tools.map((t: any) => ({
          tool: String(t.tool ?? t.name ?? ''),
          arguments: (t.arguments ?? t.args ?? {}) as Record<string, unknown>,
          reason: String(t.reason ?? ''),
        })).filter((t: PlannedToolCall) => t.tool)
        : [];

      const sequence: string[] = Array.isArray(parsed.sequence)
        ? parsed.sequence.map(String)
        : tools.map(t => t.tool);

      const confidence = typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5;

      const argMap: Record<string, Record<string, unknown>> = {};
      for (const t of tools) {
        argMap[t.tool] = t.arguments;
      }

      return {
        tools,
        arguments: argMap,
        sequence,
        confidence,
        controllerModel: this.config.controllerModel,
        planningLatencyMs: latencyMs,
      };
    } catch {
      log.warn('Failed to parse controller plan JSON — returning empty plan');
      return this.emptyPlan(latencyMs);
    }
  }

  private emptyPlan(latencyMs = 0): ToolPlan {
    return {
      tools: [],
      arguments: {},
      sequence: [],
      confidence: 0,
      controllerModel: this.config.controllerModel,
      planningLatencyMs: latencyMs,
    };
  }

  getConfig(): ToolPlannerConfig {
    return { ...this.config };
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      controllerModel: this.config.controllerModel,
      confidenceThreshold: this.config.confidenceThreshold,
      hasFabric: !!this.fabric,
    };
  }
}
