"""Storage writer: DuckDB rows, LanceDB vectors, idempotent graph writes.

Everything here is safe to re-run: chunk inserts skip existing IDs, vector
writes skip duplicates and zero-vectors, graph node/edge writes check
existence first.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import duckdb

from ..schema import lineage_ref
from .acquisition import AcquiredSource
from .types import Chunk

if TYPE_CHECKING:
    from ..config import MemoryConfig

VECTOR_TABLE = "chunk_vectors"


class StorageWriter:
    def __init__(self, config: "MemoryConfig", conn: duckdb.DuckDBPyConnection):
        self.config = config
        self.conn = conn
        self._lance_db: Any = None

    # ── DuckDB ───────────────────────────────────────────────────────────
    def store_document_metadata(self, doc_id: str, src: AcquiredSource, title: str = "") -> None:
        exists = self.conn.execute(
            "SELECT 1 FROM documents WHERE doc_id = ?", [doc_id]
        ).fetchone()
        if exists:
            return
        self.conn.execute(
            "INSERT INTO documents (doc_id, source_path, source_type, title, checksum,"
            " byte_size, lineage) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [doc_id, src.source_path, src.source_type, title or src.source_path,
             src.checksum, src.byte_size, lineage_ref("agentx-memory", "document", doc_id)],
        )

    def store_chunks(self, chunks: list[Chunk]) -> int:
        """Insert chunks, skipping IDs that already exist. Returns inserted count."""
        if not chunks:
            return 0
        existing = {
            r[0] for r in self.conn.execute(
                f"SELECT chunk_id FROM chunks WHERE chunk_id IN "
                f"({','.join('?' * len(chunks))})",
                [c.chunk_id for c in chunks],
            ).fetchall()
        }
        inserted = 0
        for c in chunks:
            if c.chunk_id in existing:
                continue
            self.conn.execute(
                "INSERT INTO chunks (chunk_id, doc_id, ordinal, text, text_hash,"
                " heading_path, token_count, tier, lineage) VALUES (?,?,?,?,?,?,?,?,?)",
                [c.chunk_id, c.doc_id, c.ordinal, c.text, c.text_hash, c.heading_path,
                 c.token_count, c.tier, lineage_ref("agentx-memory", "chunk", c.chunk_id)],
            )
            inserted += 1
        return inserted

    # ── LanceDB vectors ──────────────────────────────────────────────────
    def _lance(self) -> Any:
        if self._lance_db is None:
            import lancedb

            self.config.vectors_dir.mkdir(parents=True, exist_ok=True)
            self._lance_db = lancedb.connect(str(self.config.vectors_dir))
        return self._lance_db

    def get_existing_chunk_ids(self) -> set[str]:
        db = self._lance()
        if VECTOR_TABLE not in db.table_names():
            return set()
        tbl = db.open_table(VECTOR_TABLE)
        if not tbl.count_rows():
            return set()
        return set(tbl.to_arrow().column("chunk_id").to_pylist())

    def store_embeddings(self, chunks: list[Chunk]) -> int:
        """Store chunk vectors; skip duplicates and zero-vectors. Returns stored count."""
        rows = []
        existing = self.get_existing_chunk_ids()
        for c in chunks:
            if c.embedding is None or c.chunk_id in existing:
                continue
            if not any(v != 0.0 for v in c.embedding):
                continue  # zero vector — embedding failure artifact, never store
            rows.append({
                "chunk_id": c.chunk_id,
                "doc_id": c.doc_id,
                "vector": c.embedding,
                "text": c.text,
                "heading_path": c.heading_path,
                "tier": c.tier,
            })
        if not rows:
            return 0
        db = self._lance()
        if VECTOR_TABLE in db.table_names():
            db.open_table(VECTOR_TABLE).add(rows)
        else:
            db.create_table(VECTOR_TABLE, rows)
        return len(rows)

    def vector_search(self, vector: list[float], limit: int = 12) -> list[dict[str, Any]]:
        db = self._lance()
        if VECTOR_TABLE not in db.table_names():
            return []
        tbl = db.open_table(VECTOR_TABLE)
        results = tbl.search(vector).metric("cosine").limit(limit).to_list()
        for r in results:
            r["score"] = 1.0 - float(r.get("_distance", 1.0))
            r.pop("vector", None)
        return results

    # ── Knowledge graph (idempotent) ─────────────────────────────────────
    def node_exists(self, node_id: str) -> bool:
        try:
            return self.conn.execute(
                "SELECT 1 FROM graph_nodes WHERE node_id = ?", [node_id]
            ).fetchone() is not None
        except Exception:  # noqa: BLE001 — missing table etc. = "doesn't exist"
            return False

    def edge_exists(self, src_id: str, dst_id: str, relation: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM graph_edges WHERE src_id=? AND dst_id=? AND relation=?",
            [src_id, dst_id, relation],
        ).fetchone()
        return row is not None

    def store_graph_node(self, node_id: str, kind: str, label: str, text: str = "") -> bool:
        """Insert if absent. Chunk nodes store EMPTY text — the chunk row is
        the single source of truth; duplicating text bloats the graph."""
        if self.node_exists(node_id):
            return False
        if kind == "chunk":
            text = ""
        self.conn.execute(
            "INSERT INTO graph_nodes (node_id, kind, label, text) VALUES (?,?,?,?)",
            [node_id, kind, label, text],
        )
        return True

    def store_graph_edge(self, src_id: str, dst_id: str, relation: str, weight: float = 1.0) -> bool:
        if self.edge_exists(src_id, dst_id, relation):
            return False
        self.conn.execute(
            "INSERT INTO graph_edges (src_id, dst_id, relation, weight) VALUES (?,?,?,?)",
            [src_id, dst_id, relation, weight],
        )
        return True

    def store_graph_nodes_for_chunks(self, chunks: list[Chunk]) -> int:
        added = 0
        for c in chunks:
            if self.store_graph_node(c.chunk_id, "chunk", c.heading_path or c.chunk_id):
                added += 1
            if self.store_graph_edge(c.doc_id, c.chunk_id, "contains"):
                pass
        return added

    # ── Audit ────────────────────────────────────────────────────────────
    def write_audit(self, audit_id: str, query: str, query_type: str,
                    evidence_ids: list[str], top_score: float, answered: bool) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO retrieval_audit (audit_id, query, query_type,"
            " evidence_ids, top_score, answered) VALUES (?,?,?,?,?,?)",
            [audit_id, query, query_type, json.dumps(evidence_ids), top_score, answered],
        )
