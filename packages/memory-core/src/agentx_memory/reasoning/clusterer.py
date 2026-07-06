"""EvidenceClusterer: group evidence along an axis, detect conflicts.

Clusters give the answer layer corroboration structure: independent
clusters agreeing on a claim is far stronger evidence than one document
repeated five times.
"""

from __future__ import annotations

import re
from collections import defaultdict

from .types import EvidenceCluster, EvidenceStance, QueryIntent, QueryType, RetrievedEvidence

_NEGATION_RX = re.compile(r"\b(not|never|no longer|isn't|wasn't|doesn't|didn't|cannot|can't|denied|rejected|false)\b", re.I)
_NUMBER_RX = re.compile(r"\b\d[\d,.]*\b")


class EvidenceClusterer:
    def select_axis(self, intent: QueryIntent, evidence: list[RetrievedEvidence]) -> str:
        """Auto axis: comparisons cluster by document (compare sources);
        heading-rich evidence clusters by heading; otherwise by tier."""
        if intent.query_type is QueryType.COMPARISON:
            return "document"
        with_headings = sum(1 for e in evidence if e.heading_path)
        if evidence and with_headings / len(evidence) >= 0.6:
            return "heading"
        return "tier"

    def cluster(self, evidence: list[RetrievedEvidence], intent: QueryIntent,
                axis: str | None = None) -> list[EvidenceCluster]:
        if not evidence:
            return []
        axis = axis or self.select_axis(intent, evidence)
        groups: dict[str, list[RetrievedEvidence]] = defaultdict(list)
        for ev in evidence:
            if axis == "document":
                key = ev.doc_id
            elif axis == "heading":
                key = ev.heading_path.split(" > ")[0] if ev.heading_path else "(none)"
            else:
                key = ev.tier.value
            groups[key].append(ev)
        clusters = [
            EvidenceCluster(key=k, axis=axis, evidence=v,
                            has_conflict=self._detect_conflict(v))
            for k, v in groups.items()
        ]
        return sorted(clusters, key=lambda c: -max(e.score for e in c.evidence))

    def _detect_conflict(self, evidence: list[RetrievedEvidence]) -> bool:
        """Heuristic conflict detection: within a cluster, one negated and one
        non-negated statement, or disagreeing numbers, flags a conflict."""
        if len(evidence) < 2:
            return False
        negated = [bool(_NEGATION_RX.search(e.text)) for e in evidence]
        conflict = any(negated) and not all(negated)
        numbers = [set(_NUMBER_RX.findall(e.text)) for e in evidence]
        non_empty = [n for n in numbers if n]
        if len(non_empty) >= 2 and not set.intersection(*non_empty):
            conflict = True
        if conflict:
            for e in evidence:
                e.stance = EvidenceStance.CONFLICTS if _NEGATION_RX.search(e.text) else EvidenceStance.SUPPORTS
        return conflict
