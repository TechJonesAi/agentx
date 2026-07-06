"""Retrievers: canonical chunks, summaries, raw evidence, episodes, graph.

All retrievers degrade gracefully — a missing table or empty store returns
[] rather than raising, so the reasoning pipeline always completes.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

import duckdb

from ..ingestion.storage import StorageWriter
from .types import EvidenceTier, QueryIntent, RetrievedEvidence

if TYPE_CHECKING:
    from ..config import MemoryConfig


class Embedder(Protocol):
    def embed_text(self, text: str) -> list[float]: ...


def _kw_like(keywords: list[str], column: str = "text") -> tuple[str, list[str]]:
    """Build an OR of case-insensitive LIKE clauses for keywords."""
    kws = keywords[:8] or [""]
    clause = " OR ".join([f"lower({column}) LIKE ?" for _ in kws])
    return clause, [f"%{k.lower()}%" for k in kws]


class CanonicalChunkRetriever:
    """Vector + keyword retrieval over chunks; canonical-tier rows get a boost
    and results deduplicate by text hash (same text via two paths = one hit)."""

    CANONICAL_BOOST = 0.15

    def __init__(self, config: "MemoryConfig", conn: duckdb.DuckDBPyConnection,
                 embedder: Embedder | None = None):
        self.conn = conn
        self.storage = StorageWriter(config, conn)
        self.embedder = embedder

    def retrieve(self, intent: QueryIntent, limit: int = 12,
                 doc_ids: list[str] | None = None) -> list[RetrievedEvidence]:
        out: dict[str, RetrievedEvidence] = {}
        seen_hashes: set[str] = set()

        # Vector lane (best-effort)
        if self.embedder is not None:
            try:
                vec = self.embedder.embed_text(intent.query)
                for hit in self.storage.vector_search(vec, limit=limit * 2):
                    if doc_ids and hit["doc_id"] not in doc_ids:
                        continue
                    ev = RetrievedEvidence(
                        chunk_id=hit["chunk_id"], doc_id=hit["doc_id"], text=hit["text"],
                        score=float(hit["score"]), heading_path=hit.get("heading_path", ""),
                        tier=EvidenceTier.CANONICAL if hit.get("tier") == "canonical" else EvidenceTier.RAW,
                    )
                    if ev.tier is EvidenceTier.CANONICAL:
                        ev.score += self.CANONICAL_BOOST
                    out[ev.chunk_id] = ev
            except Exception:  # noqa: BLE001 — vector lane is optional
                pass

        # Keyword/metadata lane
        rows = self._metadata_search(intent, limit * 2, doc_ids)
        for r in rows:
            ev = RetrievedEvidence(
                chunk_id=r[0], doc_id=r[1], text=r[2], heading_path=r[3] or "",
                tier=EvidenceTier.CANONICAL if r[4] == "canonical" else EvidenceTier.RAW,
                score=0.35 + (self.CANONICAL_BOOST if r[4] == "canonical" else 0.0),
            )
            if ev.chunk_id not in out:
                out[ev.chunk_id] = ev

        # Dedup by text hash, keep the higher-scored representative.
        deduped: list[RetrievedEvidence] = []
        for ev in sorted(out.values(), key=lambda e: -e.score):
            row = self.conn.execute(
                "SELECT text_hash FROM chunks WHERE chunk_id = ?", [ev.chunk_id]).fetchone()
            th = row[0] if row else ev.chunk_id
            if th in seen_hashes:
                continue
            seen_hashes.add(th)
            deduped.append(ev)
        return deduped[:limit]

    def _metadata_search(self, intent: QueryIntent, limit: int,
                         doc_ids: list[str] | None) -> list[tuple]:
        try:
            clause, params = _kw_like(intent.keywords)
            narrowing = ""
            if doc_ids:
                narrowing = f" AND doc_id IN ({','.join('?' * len(doc_ids))})"
                params = params + doc_ids
            return self.conn.execute(
                f"SELECT chunk_id, doc_id, text, heading_path, tier FROM chunks"
                f" WHERE ({clause}){narrowing} LIMIT {int(limit)}", params).fetchall()
        except Exception:  # noqa: BLE001
            return []


class SummaryRetriever:
    """Keyword retrieval over generated summaries; dedup by summary id."""

    def __init__(self, conn: duckdb.DuckDBPyConnection):
        self.conn = conn

    def retrieve(self, intent: QueryIntent, limit: int = 6) -> list[RetrievedEvidence]:
        try:
            clause, params = _kw_like(intent.keywords)
            rows = self.conn.execute(
                f"SELECT summary_id, coalesce(doc_id, target_id), text, coalesce(heading_path,'')"
                f" FROM summaries WHERE {clause} LIMIT {int(limit) * 2}", params).fetchall()
        except Exception:  # noqa: BLE001 — no summaries table yet
            return []
        seen: set[str] = set()
        out: list[RetrievedEvidence] = []
        for r in rows:
            if r[0] in seen:
                continue
            seen.add(r[0])
            out.append(RetrievedEvidence(
                chunk_id=r[0], doc_id=r[1], text=r[2], heading_path=r[3],
                tier=EvidenceTier.SUMMARY, score=0.5))
        return out[:limit]


class RawEvidenceRetriever:
    """Direct chunk access: by IDs (with optional neighbour context window),
    by document, or by heading-path prefix."""

    def __init__(self, conn: duckdb.DuckDBPyConnection):
        self.conn = conn

    def by_chunk_ids(self, chunk_ids: list[str], context_window: int = 0) -> list[RetrievedEvidence]:
        if not chunk_ids:
            return []
        rows = self.conn.execute(
            f"SELECT chunk_id, doc_id, ordinal, text, heading_path FROM chunks"
            f" WHERE chunk_id IN ({','.join('?' * len(chunk_ids))})", chunk_ids).fetchall()
        result: dict[str, RetrievedEvidence] = {}
        for r in rows:
            result[r[0]] = RetrievedEvidence(
                chunk_id=r[0], doc_id=r[1], text=r[3], heading_path=r[4] or "",
                tier=EvidenceTier.RAW, score=1.0)
            if context_window > 0:
                neighbours = self.conn.execute(
                    "SELECT chunk_id, doc_id, ordinal, text, heading_path FROM chunks"
                    " WHERE doc_id = ? AND abs(ordinal - ?) <= ? AND chunk_id != ?",
                    [r[1], r[2], context_window, r[0]]).fetchall()
                for n in neighbours:
                    result.setdefault(n[0], RetrievedEvidence(
                        chunk_id=n[0], doc_id=n[1], text=n[3], heading_path=n[4] or "",
                        tier=EvidenceTier.RAW, score=0.6))
        return list(result.values())

    def by_document(self, doc_id: str, limit: int = 50) -> list[RetrievedEvidence]:
        rows = self.conn.execute(
            "SELECT chunk_id, doc_id, text, heading_path FROM chunks WHERE doc_id = ?"
            " ORDER BY ordinal LIMIT ?", [doc_id, limit]).fetchall()
        return [RetrievedEvidence(chunk_id=r[0], doc_id=r[1], text=r[2],
                                  heading_path=r[3] or "", tier=EvidenceTier.RAW, score=0.8)
                for r in rows]

    def by_heading_path(self, prefix: str, limit: int = 20) -> list[RetrievedEvidence]:
        rows = self.conn.execute(
            "SELECT chunk_id, doc_id, text, heading_path FROM chunks"
            " WHERE heading_path LIKE ? ORDER BY ordinal LIMIT ?",
            [f"{prefix}%", limit]).fetchall()
        return [RetrievedEvidence(chunk_id=r[0], doc_id=r[1], text=r[2],
                                  heading_path=r[3] or "", tier=EvidenceTier.RAW, score=0.8)
                for r in rows]


class EpisodicRetriever:
    """Keyword search over conversation episodes; graceful when table absent."""

    def __init__(self, conn: duckdb.DuckDBPyConnection):
        self.conn = conn

    def retrieve(self, intent: QueryIntent, limit: int = 4) -> list[RetrievedEvidence]:
        try:
            clause, params = _kw_like(intent.keywords)
            rows = self.conn.execute(
                f"SELECT episode_id, text FROM episodes WHERE {clause}"
                f" ORDER BY occurred_at DESC LIMIT {int(limit)}", params).fetchall()
        except Exception:  # noqa: BLE001 — no episodes table
            return []
        return [RetrievedEvidence(chunk_id=r[0], doc_id="episodic", text=r[1],
                                  tier=EvidenceTier.EPISODIC, score=0.4)
                for r in rows]


class GraphRetriever:
    """Entity/concept lookups against the knowledge graph. All failures → []."""

    def __init__(self, conn: duckdb.DuckDBPyConnection):
        self.conn = conn

    def find_entities(self, labels: list[str]) -> list[str]:
        if not labels:
            return []
        try:
            clause = " OR ".join(["lower(label) LIKE ?" for _ in labels])
            rows = self.conn.execute(
                f"SELECT node_id FROM graph_nodes WHERE kind IN ('entity','concept')"
                f" AND ({clause})", [f"%{l.lower()}%" for l in labels]).fetchall()
            return [r[0] for r in rows]
        except Exception:  # noqa: BLE001
            return []

    def find_concepts(self, keywords: list[str]) -> list[str]:
        return self.find_entities(keywords)

    def get_entity_mentions(self, node_ids: list[str]) -> list[str]:
        """Chunk IDs connected to the given nodes via 'mentions' edges."""
        if not node_ids:
            return []
        try:
            rows = self.conn.execute(
                f"SELECT DISTINCT dst_id FROM graph_edges WHERE relation = 'mentions'"
                f" AND src_id IN ({','.join('?' * len(node_ids))})", node_ids).fetchall()
            return [r[0] for r in rows]
        except Exception:  # noqa: BLE001
            return []


class GraphExpander:
    """When the intent asks for it, pull chunks mentioned by matched entities
    into the evidence pool (tier=GRAPH)."""

    def __init__(self, conn: duckdb.DuckDBPyConnection):
        self.graph = GraphRetriever(conn)
        self.raw = RawEvidenceRetriever(conn)

    def expand(self, intent: QueryIntent,
               existing: list[RetrievedEvidence]) -> list[RetrievedEvidence]:
        if not intent.needs_graph_expansion:
            return []
        nodes = self.graph.find_entities(intent.entities)
        mention_ids = self.graph.get_entity_mentions(nodes)
        have = {e.chunk_id for e in existing}
        extra = [c for c in mention_ids if c not in have][:8]
        out = self.raw.by_chunk_ids(extra)
        for ev in out:
            ev.tier = EvidenceTier.GRAPH
            ev.score = 0.45
        return out
