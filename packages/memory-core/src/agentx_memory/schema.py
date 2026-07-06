"""Deterministic IDs, DuckDB schema, and the migration framework.

Every ID is a content-derived SHA-256 prefix, so re-ingesting the same
material always produces the same rows — the whole system is idempotent by
construction. Lineage fields let the TypeScript core and this service refer
to the same objects across process boundaries.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import TYPE_CHECKING

import duckdb

if TYPE_CHECKING:
    from .config import MemoryConfig

ID_LEN = 24  # hex chars of sha256 — collision-safe at this corpus scale


def _det_id(prefix: str, *parts: str) -> str:
    h = hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:ID_LEN]
    return f"{prefix}_{h}"


def document_id(source_path: str, checksum: str) -> str:
    """Deterministic: same file content at the same path → same ID."""
    return _det_id("doc", source_path, checksum)


def chunk_id(doc_id: str, ordinal: int, text: str) -> str:
    """Deterministic: same document, position, and text → same ID."""
    return _det_id("chk", doc_id, str(ordinal), text)


def summary_id(scope: str, target_id: str, text_checksum: str) -> str:
    return _det_id("sum", scope, target_id, text_checksum)


def fact_id(subject: str, predicate: str, obj: str) -> str:
    return _det_id("fct", subject.lower(), predicate.lower(), obj.lower())


def lineage_ref(system: str, kind: str, ident: str) -> str:
    """Cross-system lineage field, e.g. 'agentx-memory:chunk:chk_ab12…'."""
    return f"{system}:{kind}:{ident}"


def is_deterministic_id(value: str) -> bool:
    prefix, _, h = value.partition("_")
    return prefix in {"doc", "chk", "sum", "fct"} and len(h) == ID_LEN and all(
        c in "0123456789abcdef" for c in h
    )


# ─── Migrations ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    up: str
    down: str


MIGRATIONS: list[Migration] = [
    Migration(
        version=1,
        name="core_schema",
        up="""
        CREATE TABLE IF NOT EXISTS documents (
            doc_id       VARCHAR PRIMARY KEY,
            source_path  VARCHAR NOT NULL,
            source_type  VARCHAR NOT NULL,
            title        VARCHAR,
            checksum     VARCHAR NOT NULL,
            byte_size    BIGINT,
            lineage      VARCHAR,
            ingested_at  TIMESTAMP DEFAULT current_timestamp
        );
        CREATE TABLE IF NOT EXISTS chunks (
            chunk_id     VARCHAR PRIMARY KEY,
            doc_id       VARCHAR NOT NULL,
            ordinal      INTEGER NOT NULL,
            text         VARCHAR NOT NULL,
            text_hash    VARCHAR NOT NULL,
            heading_path VARCHAR,
            token_count  INTEGER,
            tier         VARCHAR DEFAULT 'raw',
            lineage      VARCHAR,
            created_at   TIMESTAMP DEFAULT current_timestamp
        );
        CREATE TABLE IF NOT EXISTS ingestion_jobs (
            job_id       VARCHAR PRIMARY KEY,
            source_path  VARCHAR NOT NULL,
            checksum     VARCHAR,
            status       VARCHAR NOT NULL,
            stage        VARCHAR NOT NULL,
            error        VARCHAR,
            started_at   TIMESTAMP DEFAULT current_timestamp,
            updated_at   TIMESTAMP DEFAULT current_timestamp
        );
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version      INTEGER PRIMARY KEY,
            name         VARCHAR NOT NULL,
            applied_at   TIMESTAMP DEFAULT current_timestamp
        );
        """,
        down="""
        DROP TABLE IF EXISTS documents;
        DROP TABLE IF EXISTS chunks;
        DROP TABLE IF EXISTS ingestion_jobs;
        DROP TABLE IF EXISTS schema_migrations;
        """,
    ),
    Migration(
        version=2,
        name="reasoning_tables",
        up="""
        CREATE TABLE IF NOT EXISTS summaries (
            summary_id   VARCHAR PRIMARY KEY,
            scope        VARCHAR NOT NULL,          -- 'document' | 'section' | 'canonical'
            target_id    VARCHAR NOT NULL,          -- doc_id or heading key
            doc_id       VARCHAR,
            text         VARCHAR NOT NULL,
            heading_path VARCHAR,
            created_at   TIMESTAMP DEFAULT current_timestamp
        );
        CREATE TABLE IF NOT EXISTS graph_nodes (
            node_id      VARCHAR PRIMARY KEY,
            kind         VARCHAR NOT NULL,          -- 'entity' | 'concept' | 'chunk' | 'document'
            label        VARCHAR NOT NULL,
            text         VARCHAR DEFAULT '',
            created_at   TIMESTAMP DEFAULT current_timestamp
        );
        CREATE TABLE IF NOT EXISTS graph_edges (
            src_id       VARCHAR NOT NULL,
            dst_id       VARCHAR NOT NULL,
            relation     VARCHAR NOT NULL,
            weight       DOUBLE DEFAULT 1.0,
            created_at   TIMESTAMP DEFAULT current_timestamp
        );
        CREATE TABLE IF NOT EXISTS episodes (
            episode_id   VARCHAR PRIMARY KEY,
            text         VARCHAR NOT NULL,
            kind         VARCHAR DEFAULT 'conversation',
            occurred_at  TIMESTAMP DEFAULT current_timestamp
        );
        CREATE TABLE IF NOT EXISTS retrieval_audit (
            audit_id     VARCHAR PRIMARY KEY,
            query        VARCHAR NOT NULL,
            query_type   VARCHAR,
            evidence_ids VARCHAR,                   -- JSON array of chunk ids
            top_score    DOUBLE,
            answered     BOOLEAN,
            created_at   TIMESTAMP DEFAULT current_timestamp
        );
        """,
        down="""
        DROP TABLE IF EXISTS summaries;
        DROP TABLE IF EXISTS graph_nodes;
        DROP TABLE IF EXISTS graph_edges;
        DROP TABLE IF EXISTS episodes;
        DROP TABLE IF EXISTS retrieval_audit;
        """,
    ),
]


class MigrationManager:
    """Tracks applied schema versions in schema_migrations. Idempotent."""

    def __init__(self, config: "MemoryConfig", conn: duckdb.DuckDBPyConnection | None = None):
        self.config = config
        self._own_conn = conn is None
        if conn is None:
            config.data_dir.mkdir(parents=True, exist_ok=True)
            conn = duckdb.connect(str(config.db_path))
        self.conn = conn
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            " version INTEGER PRIMARY KEY, name VARCHAR NOT NULL,"
            " applied_at TIMESTAMP DEFAULT current_timestamp)"
        )

    def __enter__(self) -> "MigrationManager":
        return self

    def __exit__(self, *exc: object) -> None:
        if self._own_conn:
            self.conn.close()

    def current_version(self) -> int:
        row = self.conn.execute("SELECT max(version) FROM schema_migrations").fetchone()
        return int(row[0]) if row and row[0] is not None else 0

    def migrate(self, target: int | None = None) -> int:
        target = target if target is not None else max(m.version for m in MIGRATIONS)
        for m in sorted(MIGRATIONS, key=lambda m: m.version):
            if m.version <= self.current_version() or m.version > target:
                continue
            self.conn.execute(m.up)
            self.conn.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
                [m.version, m.name],
            )
        return self.current_version()

    def rollback(self, to_version: int) -> int:
        for m in sorted(MIGRATIONS, key=lambda m: -m.version):
            if m.version <= to_version or m.version > self.current_version():
                continue
            self.conn.execute(m.down)
            self.conn.execute("DELETE FROM schema_migrations WHERE version = ?", [m.version])
        return self.current_version()

    def table_names(self) -> set[str]:
        rows = self.conn.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='main'"
        ).fetchall()
        return {r[0] for r in rows}
