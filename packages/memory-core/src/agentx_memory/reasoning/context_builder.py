"""ContextBuilder: assemble evidence into a token-budgeted, cited context."""

from __future__ import annotations

from ..ingestion.chunking import estimate_tokens
from ..schema import lineage_ref
from .types import ContextPack, EvidenceCluster, QueryIntent, RetrievedEvidence


class ContextBuilder:
    def __init__(self, token_budget: int = 4000):
        self.token_budget = token_budget

    def build(self, intent: QueryIntent, evidence: list[RetrievedEvidence],
              clusters: list[EvidenceCluster],
              episodic: list[RetrievedEvidence] | None = None) -> ContextPack:
        lines: list[str] = []
        used = 0
        included: list[RetrievedEvidence] = []
        lineage: list[str] = []

        pool = list(evidence) + list(episodic or [])
        for i, ev in enumerate(pool, start=1):
            entry = f"[C{i}] ({ev.tier.value}"
            if ev.heading_path:
                entry += f" | {ev.heading_path}"
            entry += f") {ev.text}"
            cost = estimate_tokens(entry)
            if used + cost > self.token_budget:
                break
            lines.append(entry)
            used += cost
            included.append(ev)
            lineage.append(lineage_ref("agentx-memory", "chunk", ev.chunk_id))

        conflict_note = ""
        if any(c.has_conflict for c in clusters):
            conflict_note = (
                "\nNOTE: some evidence sources conflict — surface the disagreement"
                " rather than picking a side silently.")

        return ContextPack(
            query=intent.query,
            intent=intent,
            evidence=included,
            clusters=clusters,
            context_text="\n\n".join(lines) + conflict_note,
            lineage_refs=lineage,
            token_count=used,
        )
