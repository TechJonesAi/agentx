"""HybridReranker: blend vector, keyword, structural, and graph signals."""

from __future__ import annotations

from .types import EvidenceTier, QueryIntent, RankingWeights, RetrievedEvidence


def keyword_score(text: str, keywords: list[str]) -> float:
    """Fraction of query keywords present in the text (0..1)."""
    if not keywords:
        return 0.0
    lower = text.lower()
    hits = sum(1 for k in keywords if k.lower() in lower)
    return hits / len(keywords)


def structural_score(evidence: RetrievedEvidence, intent: QueryIntent) -> float:
    """Reward heading paths that overlap query keywords/entities — evidence
    filed under a matching section is structurally on-topic."""
    if not evidence.heading_path:
        return 0.0
    hp = evidence.heading_path.lower()
    terms = [k.lower() for k in intent.keywords] + [e.lower() for e in intent.entities]
    if not terms:
        return 0.0
    hits = sum(1 for t in terms if t in hp)
    return min(hits / max(len(terms), 1) * 2.0, 1.0)


class HybridReranker:
    def __init__(self, weights: RankingWeights | None = None):
        self.weights = weights or RankingWeights()

    def rerank(self, evidence: list[RetrievedEvidence],
               intent: QueryIntent) -> list[RetrievedEvidence]:
        if not evidence:
            return []
        w = self.weights
        for ev in evidence:
            graph_boost = 1.0 if ev.tier is EvidenceTier.GRAPH else 0.0
            ev.score = (
                w.vector * min(max(ev.score, 0.0), 1.0)
                + w.keyword * keyword_score(ev.text, intent.keywords)
                + w.structural * structural_score(ev, intent)
                + w.graph * graph_boost
            )
        return sorted(evidence, key=lambda e: -e.score)
