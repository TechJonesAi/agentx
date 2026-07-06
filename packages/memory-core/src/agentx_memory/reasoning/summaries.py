"""SummaryGenerator: extractive document/section summaries + canonical chunks.

Extractive (lead sentences per section) rather than LLM-generated, so
summaries are deterministic, instant, and never hallucinate. IDs derive
from content — regeneration is idempotent.
"""

from __future__ import annotations

import hashlib

import duckdb

from ..ingestion.chunking import split_into_sentences
from ..schema import summary_id as make_summary_id


class SummaryGenerator:
    def __init__(self, conn: duckdb.DuckDBPyConnection):
        self.conn = conn

    def _store(self, scope: str, target_id: str, doc_id: str | None,
               text: str, heading_path: str = "") -> str:
        checksum = hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]
        sid = make_summary_id(scope, target_id, checksum)
        exists = self.conn.execute(
            "SELECT 1 FROM summaries WHERE summary_id = ?", [sid]).fetchone()
        if not exists:
            self.conn.execute(
                "INSERT INTO summaries (summary_id, scope, target_id, doc_id, text,"
                " heading_path) VALUES (?,?,?,?,?,?)",
                [sid, scope, target_id, doc_id, text, heading_path])
        return sid

    def generate_document_summary(self, doc_id: str, max_sentences: int = 5) -> str | None:
        rows = self.conn.execute(
            "SELECT text FROM chunks WHERE doc_id = ? ORDER BY ordinal LIMIT 10",
            [doc_id]).fetchall()
        if not rows:
            return None
        sentences: list[str] = []
        for r in rows:
            sentences.extend(split_into_sentences(r[0])[:1])  # lead sentence per chunk
            if len(sentences) >= max_sentences:
                break
        return self._store("document", doc_id, doc_id, " ".join(sentences[:max_sentences]))

    def generate_section_summaries(self, doc_id: str, max_sentences: int = 2) -> list[str]:
        rows = self.conn.execute(
            "SELECT heading_path, string_agg(text, ' ' ORDER BY ordinal) FROM chunks"
            " WHERE doc_id = ? AND heading_path != '' GROUP BY heading_path",
            [doc_id]).fetchall()
        out = []
        for heading_path, text in rows:
            lead = " ".join(split_into_sentences(text)[:max_sentences])
            out.append(self._store("section", f"{doc_id}:{heading_path}", doc_id,
                                   lead, heading_path))
        return out

    def generate_canonical_chunks(self, doc_id: str, top_n: int = 3) -> list[str]:
        """Promote the longest (most information-dense) chunks to canonical
        tier so retrieval boosts them."""
        rows = self.conn.execute(
            "SELECT chunk_id FROM chunks WHERE doc_id = ? ORDER BY token_count DESC"
            " LIMIT ?", [doc_id, top_n]).fetchall()
        ids = [r[0] for r in rows]
        if ids:
            self.conn.execute(
                f"UPDATE chunks SET tier = 'canonical' WHERE chunk_id IN"
                f" ({','.join('?' * len(ids))})", ids)
        return ids

    def generate_all(self, doc_id: str) -> dict[str, object]:
        return {
            "document_summary": self.generate_document_summary(doc_id),
            "section_summaries": self.generate_section_summaries(doc_id),
            "canonical_chunks": self.generate_canonical_chunks(doc_id),
        }
