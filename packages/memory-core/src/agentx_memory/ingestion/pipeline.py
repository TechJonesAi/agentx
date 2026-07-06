"""End-to-end ingestion pipeline with resumable job tracking.

Jobs move through acquire → parse → normalize → chunk → embed → store,
recording the current stage in ingestion_jobs. A job that died mid-flight
(status processing/failed) can be resumed; completed jobs cannot.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Protocol

import duckdb

from ..schema import document_id
from .acquisition import AcquisitionLayer, AcquiredSource
from .chunking import SemanticChunker
from .normalize import Normalizer
from .parsers import parse_document
from .storage import StorageWriter
from .types import IngestionResult, IngestionStage, IngestionStatus

if TYPE_CHECKING:
    from ..config import MemoryConfig


class Embedder(Protocol):
    def embed_batch(self, texts: list[str]) -> list[list[float]]: ...


RESUMABLE_STATUSES = {IngestionStatus.PROCESSING, IngestionStatus.FAILED}


def can_resume(status: IngestionStatus | str | None) -> bool:
    if status is None:
        return False
    return IngestionStatus(status) in RESUMABLE_STATUSES


class IngestionPipeline:
    def __init__(self, config: "MemoryConfig", conn: duckdb.DuckDBPyConnection,
                 embedder: Embedder | None = None):
        self.config = config
        self.conn = conn
        self.acquisition = AcquisitionLayer(conn)
        self.normalizer = Normalizer()
        self.chunker = SemanticChunker(config.chunk_target_tokens, config.chunk_max_tokens)
        self.storage = StorageWriter(config, conn)
        self.embedder = embedder

    # ── job control plane ────────────────────────────────────────────────
    def _job_upsert(self, job_id: str, source_path: str, checksum: str | None,
                    status: IngestionStatus, stage: IngestionStage, error: str | None = None) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO ingestion_jobs (job_id, source_path, checksum, status,"
            " stage, error, updated_at) VALUES (?,?,?,?,?,?, current_timestamp)",
            [job_id, source_path, checksum, status.value, stage.value, error],
        )

    def get_job_state(self, job_id: str) -> dict | None:
        row = self.conn.execute(
            "SELECT job_id, source_path, checksum, status, stage, error FROM ingestion_jobs"
            " WHERE job_id = ?", [job_id],
        ).fetchone()
        if row is None:
            return None
        return {"job_id": row[0], "source_path": row[1], "checksum": row[2],
                "status": IngestionStatus(row[3]), "stage": IngestionStage(row[4]),
                "error": row[5]}

    # ── pipeline ─────────────────────────────────────────────────────────
    def ingest_source(self, src: AcquiredSource, title: str = "") -> IngestionResult:
        job_id = f"job_{uuid.uuid4().hex[:16]}"
        doc_id = document_id(src.source_path, src.checksum)

        if src.is_duplicate:
            self._job_upsert(job_id, src.source_path, src.checksum,
                             IngestionStatus.DUPLICATE, IngestionStage.ACQUIRED)
            return IngestionResult(doc_id=doc_id, job_id=job_id,
                                   status=IngestionStatus.DUPLICATE,
                                   stage=IngestionStage.ACQUIRED)

        stage = IngestionStage.ACQUIRED
        self._job_upsert(job_id, src.source_path, src.checksum,
                         IngestionStatus.PROCESSING, stage)
        warnings: list[str] = []
        try:
            sections = parse_document(src.raw_text, src.source_type)
            stage = IngestionStage.PARSED
            self._job_upsert(job_id, src.source_path, src.checksum, IngestionStatus.PROCESSING, stage)

            sections = self.normalizer.normalize(sections)
            stage = IngestionStage.NORMALIZED
            self._job_upsert(job_id, src.source_path, src.checksum, IngestionStatus.PROCESSING, stage)

            chunks = self.chunker.chunk_sections(doc_id, sections)
            stage = IngestionStage.CHUNKED
            self._job_upsert(job_id, src.source_path, src.checksum, IngestionStatus.PROCESSING, stage)

            if self.embedder is not None and chunks:
                try:
                    vectors = self.embedder.embed_batch([c.text for c in chunks])
                    for c, v in zip(chunks, vectors):
                        c.embedding = v
                except Exception as exc:  # noqa: BLE001 — embedding is best-effort
                    warnings.append(f"embedding failed (stored without vectors): {exc}")
            stage = IngestionStage.EMBEDDED
            self._job_upsert(job_id, src.source_path, src.checksum, IngestionStatus.PROCESSING, stage)

            self.storage.store_document_metadata(doc_id, src, title)
            self.storage.store_chunks(chunks)
            self.storage.store_graph_node(doc_id, "document", title or src.source_path)
            self.storage.store_graph_nodes_for_chunks(chunks)
            if any(c.embedding for c in chunks):
                self.storage.store_embeddings(chunks)
            stage = IngestionStage.STORED
            self._job_upsert(job_id, src.source_path, src.checksum, IngestionStatus.COMPLETED, stage)
            return IngestionResult(doc_id=doc_id, job_id=job_id,
                                   status=IngestionStatus.COMPLETED, stage=stage,
                                   chunk_count=len(chunks), warnings=warnings)
        except Exception as exc:  # noqa: BLE001 — job records the failure
            self._job_upsert(job_id, src.source_path, src.checksum,
                             IngestionStatus.FAILED, stage, str(exc))
            return IngestionResult(doc_id=doc_id, job_id=job_id,
                                   status=IngestionStatus.FAILED, stage=stage,
                                   error=str(exc), warnings=warnings)

    def ingest_file(self, path: str, title: str = "") -> IngestionResult:
        return self.ingest_source(self.acquisition.acquire(path), title)

    def ingest_text(self, text: str, source_path: str, source_type: str = "text",
                    title: str = "") -> IngestionResult:
        return self.ingest_source(
            self.acquisition.acquire_text(text, source_path, source_type), title)
