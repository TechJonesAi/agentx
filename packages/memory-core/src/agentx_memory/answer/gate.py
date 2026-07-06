"""RelevanceGate: decide whether the evidence is strong enough to answer.

The gate exists to make the system abstain rather than hallucinate: legal
and medical users must get "I don't have evidence for that" instead of a
confident guess. All thresholds are tunable; defaults are conservative.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..reasoning.reranker import keyword_score
from ..reasoning.types import ContextPack, EvidenceTier


@dataclass
class GateResult:
    passed: bool
    reason: str
    top_score: float = 0.0
    avg_top_k: float = 0.0
    keyword_overlap: float = 0.0
    cluster_count: int = 0


@dataclass
class GateThresholds:
    min_top_score: float = 0.35
    min_avg_top_k: float = 0.25
    top_k: int = 3
    min_keyword_overlap: float = 0.15
    # Corroboration: fact-style claims need >=2 independent clusters OR a
    # summary-tier hit (summaries corroborate by construction — they compress
    # many chunks).
    require_corroboration: bool = True


class RelevanceGate:
    def __init__(self, thresholds: GateThresholds | None = None):
        self.thresholds = thresholds or GateThresholds()

    def evaluate(self, pack: ContextPack) -> GateResult:
        t = self.thresholds
        if not pack.evidence:
            return GateResult(False, "no evidence retrieved")

        scores = sorted((e.score for e in pack.evidence), reverse=True)
        top = scores[0]
        avg_top_k = sum(scores[: t.top_k]) / min(len(scores), t.top_k)
        keywords = pack.intent.keywords if pack.intent else []
        overlap = max((keyword_score(e.text, keywords) for e in pack.evidence), default=0.0)
        clusters = len(pack.clusters)
        has_summary = any(e.tier is EvidenceTier.SUMMARY for e in pack.evidence)

        def fail(reason: str) -> GateResult:
            return GateResult(False, reason, top, avg_top_k, overlap, clusters)

        if top < t.min_top_score:
            return fail(f"top score {top:.2f} below {t.min_top_score}")
        if avg_top_k < t.min_avg_top_k:
            return fail(f"avg top-{t.top_k} {avg_top_k:.2f} below {t.min_avg_top_k}")
        if overlap < t.min_keyword_overlap:
            return fail(f"keyword overlap {overlap:.2f} below {t.min_keyword_overlap}")
        if t.require_corroboration and clusters < 2 and not has_summary:
            return fail("no corroboration: fewer than 2 clusters and no summary-tier evidence")

        return GateResult(True, "passed", top, avg_top_k, overlap, clusters)
