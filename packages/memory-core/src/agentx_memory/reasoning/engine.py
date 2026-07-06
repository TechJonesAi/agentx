"""ReasoningEngine: the full pipeline, query string in → ContextPack out.

interpret → retrieve (canonical + summary + episodic) → graph-expand →
rerank → cluster → build context → audit. Every stage degrades gracefully;
an empty store yields an empty-but-well-formed ContextPack.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Protocol

import duckdb

from ..ingestion.storage import StorageWriter
from .clusterer import EvidenceClusterer
from .context_builder import ContextBuilder
from .interpreter import QueryInterpreter
from .reranker import HybridReranker
from .retrievers import (
    CanonicalChunkRetriever,
    EpisodicRetriever,
    GraphExpander,
    SummaryRetriever,
)
from .types import ContextPack, RankingWeights

if TYPE_CHECKING:
    from ..config import MemoryConfig


class Embedder(Protocol):
    def embed_text(self, text: str) -> list[float]: ...


class ReasoningEngine:
    def __init__(self, config: "MemoryConfig", conn: duckdb.DuckDBPyConnection,
                 embedder: Embedder | None = None,
                 weights: RankingWeights | None = None):
        self.config = config
        self.conn = conn
        self.interpreter = QueryInterpreter()
        self.canonical = CanonicalChunkRetriever(config, conn, embedder)
        self.summaries = SummaryRetriever(conn)
        self.episodic = EpisodicRetriever(conn)
        self.expander = GraphExpander(conn)
        self.reranker = HybridReranker(weights)
        self.clusterer = EvidenceClusterer()
        self.builder = ContextBuilder(config.context_token_budget)
        self.storage = StorageWriter(config, conn)

    def query(self, query: str, limit: int = 12,
              doc_ids: list[str] | None = None) -> ContextPack:
        intent = self.interpreter.interpret(query)

        # High-precision (fact) queries retrieve tighter.
        eff_limit = max(4, limit // 2) if intent.high_precision else limit

        evidence = self.canonical.retrieve(intent, limit=eff_limit, doc_ids=doc_ids)
        evidence += self.summaries.retrieve(intent, limit=4)
        evidence += self.expander.expand(intent, evidence)
        episodes = self.episodic.retrieve(intent, limit=3)

        evidence = self.reranker.rerank(evidence, intent)[:eff_limit]
        clusters = self.clusterer.cluster(evidence, intent)
        pack = self.builder.build(intent, evidence, clusters, episodic=episodes)

        try:
            self.storage.write_audit(
                f"aud_{uuid.uuid4().hex[:16]}", query, intent.query_type.value,
                [e.chunk_id for e in pack.evidence],
                max((e.score for e in pack.evidence), default=0.0),
                answered=bool(pack.evidence))
        except Exception:  # noqa: BLE001 — audit must never break retrieval
            pass
        return pack
