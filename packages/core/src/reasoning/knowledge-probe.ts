/**
 * Phase 2 — Knowledge Probe (K-A: no-retrieval stub)
 *
 * Returns the subset of `DecisionKnowledgeContext` that represents the state
 * of the knowledge / retrieval pipeline. On main today there is no retrieval
 * pipeline, so this stub honestly reports "no knowledge available, no
 * retrieval failure".
 *
 * The two remaining fields of `DecisionKnowledgeContext` (`detectedDomain`
 * and `queryIntent`) are the responsibility of the domain / intent
 * classifiers respectively. The Phase-4 orchestrator merges all three.
 *
 * Replace the constant return with a real probe once a retrieval pipeline
 * lands on main. The shape is fixed so callers will not need to change.
 */

export interface KnowledgeProbeResult {
  hasKnowledge: boolean;
  docChunkCount: number;
  retrievalFailed: boolean;
}

const DEFAULT_RESULT: Readonly<KnowledgeProbeResult> = Object.freeze({
  hasKnowledge: false,
  docChunkCount: 0,
  retrievalFailed: false,
});

export class KnowledgeProbe {
  probe(_query: string): KnowledgeProbeResult {
    // Return a fresh copy so callers cannot mutate the shared default.
    return { ...DEFAULT_RESULT };
  }
}
