"""AgentX Memory API — FastAPI app (uvicorn agentx_memory.api.server:app).

Supervised by the AgentX web server's ServiceSupervisor and by the launcher
watchdog. Binds localhost only (enforced by the supervisor's --host arg).

Endpoints:
  GET  /health          — component health (db, vectors, embedder)
  GET  /stats           — corpus counts
  POST /ingest          — {text, source_path, source_type?, title?}
  POST /ingest/file     — {path, title?}
  GET  /jobs/{job_id}   — ingestion job state
  POST /query           — {query, limit?, doc_ids?} → context pack
  POST /answer          — {query, limit?} → gated, cited answer
  POST /summaries/{doc_id} — generate summaries + canonical chunks
"""

from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Any

import duckdb
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .. import __version__
from ..answer.generator import AnswerGenerator
from ..config import MemoryConfig, bootstrap, load_config
from ..ingestion.embedding import MockEmbedder, OllamaEmbedder
from ..ingestion.pipeline import IngestionPipeline
from ..reasoning.engine import ReasoningEngine
from ..reasoning.summaries import SummaryGenerator


class _State:
    """Process-wide singletons. DuckDB connections are not thread-safe, so a
    lock serializes access — fine at this service's request rates."""

    config: MemoryConfig
    conn: duckdb.DuckDBPyConnection
    pipeline: IngestionPipeline
    engine: ReasoningEngine
    answerer: AnswerGenerator
    lock: threading.Lock


S = _State()


def _make_embedder(cfg: MemoryConfig) -> Any:
    if cfg.embedding_provider == "mock":
        return MockEmbedder(cfg.embedding_dimensions)
    return OllamaEmbedder(cfg.ollama_url, cfg.embedding_model, cfg.embedding_dimensions)


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = bootstrap(load_config())
    S.config = cfg
    S.conn = duckdb.connect(str(cfg.db_path))
    embedder = _make_embedder(cfg)
    S.pipeline = IngestionPipeline(cfg, S.conn, embedder=embedder)
    S.engine = ReasoningEngine(cfg, S.conn, embedder=embedder)
    S.answerer = AnswerGenerator(
        ollama_url=cfg.ollama_url, model=cfg.answer_model, enabled=cfg.answer_enabled)
    S.lock = threading.Lock()
    yield
    S.conn.close()


app = FastAPI(title="AgentX Memory API", version=__version__, lifespan=lifespan)


# ─── Models ──────────────────────────────────────────────────────────────────

class IngestTextBody(BaseModel):
    text: str
    source_path: str
    source_type: str = "text"
    title: str = ""


class IngestFileBody(BaseModel):
    path: str
    title: str = ""


class QueryBody(BaseModel):
    query: str
    limit: int = Field(default=12, ge=1, le=50)
    doc_ids: list[str] | None = None


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict[str, Any]:
    components: dict[str, str] = {}
    try:
        with S.lock:
            S.conn.execute("SELECT 1")
        components["db"] = "ok"
    except Exception as exc:  # noqa: BLE001
        components["db"] = f"error: {exc}"
    components["vectors"] = "ok" if S.config.vectors_dir.exists() else "missing"
    try:
        S.pipeline.embedder.embed_text("ping")  # type: ignore[union-attr]
        components["embedder"] = "ok"
    except Exception:  # noqa: BLE001 — embedder down = degraded, not dead
        components["embedder"] = "degraded"
    status = "ok" if components["db"] == "ok" else "error"
    return {"status": status, "version": __version__, "components": components,
            "pid": os.getpid()}


@app.get("/stats")
def stats() -> dict[str, Any]:
    with S.lock:
        docs = S.conn.execute("SELECT count(*) FROM documents").fetchone()[0]
        chunks = S.conn.execute("SELECT count(*) FROM chunks").fetchone()[0]
        summaries = S.conn.execute("SELECT count(*) FROM summaries").fetchone()[0]
        jobs = S.conn.execute(
            "SELECT status, count(*) FROM ingestion_jobs GROUP BY status").fetchall()
        audits = S.conn.execute("SELECT count(*) FROM retrieval_audit").fetchone()[0]
    return {"documents": docs, "chunks": chunks, "summaries": summaries,
            "jobs": dict(jobs), "retrieval_audits": audits}


@app.post("/ingest")
def ingest_text(body: IngestTextBody) -> dict[str, Any]:
    with S.lock:
        result = S.pipeline.ingest_text(body.text, body.source_path,
                                        body.source_type, body.title)
        if result.status.value == "completed":
            SummaryGenerator(S.conn).generate_all(result.doc_id)
    return asdict(result)


@app.post("/ingest/file")
def ingest_file(body: IngestFileBody) -> dict[str, Any]:
    if not os.path.isfile(body.path):
        raise HTTPException(status_code=404, detail=f"file not found: {body.path}")
    with S.lock:
        result = S.pipeline.ingest_file(body.path, body.title)
        if result.status.value == "completed":
            SummaryGenerator(S.conn).generate_all(result.doc_id)
    return asdict(result)


@app.get("/jobs/{job_id}")
def job_state(job_id: str) -> dict[str, Any]:
    with S.lock:
        state = S.pipeline.get_job_state(job_id)
    if state is None:
        raise HTTPException(status_code=404, detail="job not found")
    state["status"] = state["status"].value
    state["stage"] = state["stage"].value
    return state


@app.post("/query")
def query(body: QueryBody) -> dict[str, Any]:
    with S.lock:
        pack = S.engine.query(body.query, limit=body.limit, doc_ids=body.doc_ids)
    return {
        "query": pack.query,
        "query_type": pack.intent.query_type.value if pack.intent else "general",
        "evidence": [asdict(e) for e in pack.evidence],
        "clusters": [{"key": c.key, "axis": c.axis, "size": len(c.evidence),
                      "has_conflict": c.has_conflict} for c in pack.clusters],
        "context_text": pack.context_text,
        "lineage_refs": pack.lineage_refs,
        "token_count": pack.token_count,
    }


@app.post("/answer")
def answer(body: QueryBody) -> dict[str, Any]:
    with S.lock:
        pack = S.engine.query(body.query, limit=body.limit, doc_ids=body.doc_ids)
    result = S.answerer.answer(pack)  # LLM call outside the DB lock
    return {
        "status": result.status,
        "answer": result.answer,
        "citations": result.citations,
        "gate": asdict(result.gate) if result.gate else None,
        "error": result.error,
        "evidence": [asdict(e) for e in pack.evidence],
        "query_type": pack.intent.query_type.value if pack.intent else "general",
    }


@app.post("/summaries/{doc_id}")
def generate_summaries(doc_id: str) -> dict[str, Any]:
    with S.lock:
        return {k: v for k, v in SummaryGenerator(S.conn).generate_all(doc_id).items()}
