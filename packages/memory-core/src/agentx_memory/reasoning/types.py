"""Types for the reasoning engine: intents, evidence, context packs."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class QueryType(str, Enum):
    FACT = "fact"
    COMPARISON = "comparison"
    ENTITY_LOOKUP = "entity_lookup"
    EXPLANATION = "explanation"
    PROCEDURE = "procedure"
    TIMELINE = "timeline"
    GENERAL = "general"


class EvidenceTier(str, Enum):
    CANONICAL = "canonical"   # curated/boosted chunks
    SUMMARY = "summary"       # generated document/section summaries
    RAW = "raw"               # raw chunks
    EPISODIC = "episodic"     # conversation episodes
    GRAPH = "graph"           # graph-expanded evidence


class EvidenceStance(str, Enum):
    SUPPORTS = "supports"
    CONFLICTS = "conflicts"
    NEUTRAL = "neutral"


@dataclass
class QueryIntent:
    query: str
    query_type: QueryType = QueryType.GENERAL
    keywords: list[str] = field(default_factory=list)
    entities: list[str] = field(default_factory=list)
    time_scope: str | None = None       # "recent" | "range" | None
    high_precision: bool = False        # fact queries demand tight retrieval
    needs_graph_expansion: bool = False


@dataclass
class RetrievedEvidence:
    chunk_id: str
    doc_id: str
    text: str
    score: float = 0.0
    tier: EvidenceTier = EvidenceTier.RAW
    heading_path: str = ""
    stance: EvidenceStance = EvidenceStance.NEUTRAL
    lineage: str = ""


@dataclass
class EvidenceCluster:
    key: str                     # cluster axis value (doc id / heading / tier)
    axis: str                    # 'document' | 'heading' | 'tier'
    evidence: list[RetrievedEvidence] = field(default_factory=list)
    has_conflict: bool = False


@dataclass
class RankingWeights:
    vector: float = 0.55
    keyword: float = 0.25
    structural: float = 0.10
    graph: float = 0.10


@dataclass
class ContextPack:
    """The reasoning engine's final product: everything an answerer needs."""

    query: str
    intent: QueryIntent | None = None
    evidence: list[RetrievedEvidence] = field(default_factory=list)
    clusters: list[EvidenceCluster] = field(default_factory=list)
    context_text: str = ""
    lineage_refs: list[str] = field(default_factory=list)
    token_count: int = 0
    reason: str = ""             # populated when the pipeline short-circuits
