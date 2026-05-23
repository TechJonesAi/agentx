/**
 * Structured decision-trace events for the private-memory-first policy.
 *
 * Emitted by the agent during a single `chat()` / `chatStream()` call.
 * Held as a per-call ring buffer (capped) so:
 *   - tests can assert ordering + content (Batch A1/A2 harness)
 *   - the UI can render a decision-trace panel (Batch A3, follow-up)
 *   - operators can diff-trace runs for forensic privacy audits.
 *
 * No PII, no document content. Event payloads carry IDs + counts + tool
 * names + URL hosts only.
 *
 * Public API (lives on Agent):
 *   agent.getLastDecisionTrace(): PrivateMemoryEvent[]
 */

import type { RetrievalSufficiencyDecision } from '../reasoning/retrieval-sufficiency.js';

export type PrivateMemoryEventName =
  | 'retrieval_started'
  | 'retrieval_results'
  | 'retrieval_sufficiency_decision'
  | 'tool_fallback_allowed'
  | 'tool_fallback_blocked'
  | 'external_request_attempted'
  | 'external_request_blocked'
  // Batch 10 — provider-intelligence trace events
  | 'provider_benchmark_started'
  | 'provider_benchmark_completed'
  | 'provider_promoted'
  | 'provider_demoted'
  | 'provider_routing_override'
  | 'provider_localonly_block';

export interface PrivateMemoryEventBase {
  ts: number;
  event: PrivateMemoryEventName;
}

export interface RetrievalStartedEvent extends PrivateMemoryEventBase {
  event: 'retrieval_started';
  query: string;
}
export interface RetrievalResultsEvent extends PrivateMemoryEventBase {
  event: 'retrieval_results';
  matchCount: number;
  source: string;
  intent: string;
  elapsedMs: number;
}
export interface RetrievalSufficiencyEvent extends PrivateMemoryEventBase {
  event: 'retrieval_sufficiency_decision';
  sufficient: boolean;
  reason: RetrievalSufficiencyDecision['reason'];
  matchedDocumentIds: string[];
  matchedTerms: string[];
  score: number;
}
export interface ToolFallbackAllowedEvent extends PrivateMemoryEventBase {
  event: 'tool_fallback_allowed';
  tool: string;
  reason: 'insufficient_memory' | 'non_network_tool';
}
export interface ToolFallbackBlockedEvent extends PrivateMemoryEventBase {
  event: 'tool_fallback_blocked';
  tool: string;
  reason: 'sufficient_memory' | 'local_only';
}
export interface ExternalRequestAttemptedEvent extends PrivateMemoryEventBase {
  event: 'external_request_attempted';
  host: string;
}
export interface ExternalRequestBlockedEvent extends PrivateMemoryEventBase {
  event: 'external_request_blocked';
  host: string;
  reason: 'local_only';
}

// ── Batch 10 — provider-intelligence event payloads ────────────────────
export interface ProviderBenchmarkStartedEvent extends PrivateMemoryEventBase {
  event: 'provider_benchmark_started';
  taskCategory: string;
  providers: string[];
}
export interface ProviderBenchmarkCompletedEvent extends PrivateMemoryEventBase {
  event: 'provider_benchmark_completed';
  taskCategory: string;
  results: Array<{ provider: string; score: number; latencyMs?: number }>;
}
export interface ProviderPromotedEvent extends PrivateMemoryEventBase {
  event: 'provider_promoted';
  fromProvider: string;
  toProvider: string;
  taskCategory: string;
  reason: string;
}
export interface ProviderDemotedEvent extends PrivateMemoryEventBase {
  event: 'provider_demoted';
  provider: string;
  taskCategory: string;
  reason: string;
}
export interface ProviderRoutingOverrideEvent extends PrivateMemoryEventBase {
  event: 'provider_routing_override';
  origin: 'user_pin' | 'localonly_block' | 'availability';
  taskCategory: string;
  reason: string;
}
export interface ProviderLocalOnlyBlockEvent extends PrivateMemoryEventBase {
  event: 'provider_localonly_block';
  endpoint: string;
  reason: string;
}

export type PrivateMemoryEvent =
  | RetrievalStartedEvent
  | RetrievalResultsEvent
  | RetrievalSufficiencyEvent
  | ToolFallbackAllowedEvent
  | ToolFallbackBlockedEvent
  | ExternalRequestAttemptedEvent
  | ExternalRequestBlockedEvent
  | ProviderBenchmarkStartedEvent
  | ProviderBenchmarkCompletedEvent
  | ProviderPromotedEvent
  | ProviderDemotedEvent
  | ProviderRoutingOverrideEvent
  | ProviderLocalOnlyBlockEvent;

const MAX_EVENTS_PER_CALL = 64;

export class DecisionTraceBuffer {
  private events: PrivateMemoryEvent[] = [];

  reset(): void { this.events = []; }
  snapshot(): PrivateMemoryEvent[] { return [...this.events]; }
  count(): number { return this.events.length; }

  /**
   * Emit a structured event. The buffer stamps `ts`. The parameter is
   * deliberately typed loosely (any payload with an `event` key) because
   * the call-site uses object-literal-with-discriminator and TS narrows
   * the union via the `event` field at runtime; a strict union-typed
   * parameter would force the caller into per-event helper methods.
   */
  emit(e: { event: PrivateMemoryEventName } & Record<string, unknown>): void {
    if (this.events.length >= MAX_EVENTS_PER_CALL) return;
    this.events.push({ ts: Date.now(), ...e } as unknown as PrivateMemoryEvent);
  }
}

/** Convenience: pick all events of a given type from a snapshot. */
export function filterEvents<E extends PrivateMemoryEventName>(
  trace: PrivateMemoryEvent[],
  event: E,
): Extract<PrivateMemoryEvent, { event: E }>[] {
  return trace.filter((e) => e.event === event) as Extract<PrivateMemoryEvent, { event: E }>[];
}
