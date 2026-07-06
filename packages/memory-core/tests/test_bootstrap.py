"""Bootstrap, config validation, schema/migration framework, deterministic IDs."""

import duckdb
import pytest

from agentx_memory.config import ConfigError, MemoryConfig, bootstrap, load_config
from agentx_memory.schema import (
    MigrationManager,
    chunk_id,
    document_id,
    fact_id,
    is_deterministic_id,
    lineage_ref,
)


def test_bootstrap_creates_folders(tmp_path):
    cfg = bootstrap(MemoryConfig(data_dir=tmp_path / "mem"))
    assert cfg.data_dir.is_dir()
    assert cfg.vectors_dir.is_dir()
    assert cfg.inbox_dir.is_dir()
    assert cfg.archive_dir.is_dir()


def test_bootstrap_creates_configs(tmp_path):
    cfg = bootstrap(MemoryConfig(data_dir=tmp_path / "mem"))
    assert cfg.config_path.exists()
    loaded = load_config(cfg.data_dir)
    assert loaded.embedding_model == cfg.embedding_model


def test_full_bootstrap(tmp_path):
    cfg = bootstrap(MemoryConfig(data_dir=tmp_path / "mem"))
    conn = duckdb.connect(str(cfg.db_path))
    with MigrationManager(cfg, conn) as mm:
        assert mm.current_version() == 2
        assert {"documents", "chunks", "summaries", "graph_nodes",
                "ingestion_jobs"} <= mm.table_names()


def test_memory_config_validation():
    cfg = MemoryConfig()
    assert cfg.embedding_provider == "ollama"
    assert cfg.embedding_dimensions == 768


def test_memory_config_invalid_provider():
    with pytest.raises(ConfigError):
        MemoryConfig(embedding_provider="openai")


def test_memory_config_invalid_dimensions():
    with pytest.raises(ConfigError):
        MemoryConfig(embedding_dimensions=777)


class TestBootstrapIdempotency:
    def test_repeated_bootstrap(self, tmp_path):
        cfg = bootstrap(MemoryConfig(data_dir=tmp_path / "mem"))
        cfg2 = bootstrap(MemoryConfig(data_dir=tmp_path / "mem"))
        assert cfg.db_path == cfg2.db_path

    def test_idempotent_schema_creation(self, cfg):
        for _ in range(3):
            with MigrationManager(cfg) as mm:
                assert mm.migrate() == 2


class TestControlPlaneTables:
    def test_control_plane_tables_exist(self, cfg, conn):
        with MigrationManager(cfg, conn) as mm:
            assert "ingestion_jobs" in mm.table_names()
            assert "schema_migrations" in mm.table_names()

    def test_ingestion_jobs_schema(self, conn):
        cols = {r[0] for r in conn.execute(
            "SELECT column_name FROM information_schema.columns"
            " WHERE table_name = 'ingestion_jobs'").fetchall()}
        assert {"job_id", "status", "stage", "error"} <= cols


class TestMigrationFramework:
    def test_migration_manager_initialization(self, cfg):
        with MigrationManager(cfg) as mm:
            assert mm.current_version() >= 0

    def test_migration_version_tracking(self, cfg, conn):
        with MigrationManager(cfg, conn) as mm:
            v = mm.current_version()
            assert v == 2
            assert mm.migrate() == v  # no-op re-run

    def test_migration_rollback(self, tmp_path):
        cfg = bootstrap(MemoryConfig(data_dir=tmp_path / "roll"))
        with MigrationManager(cfg) as mm:
            assert mm.rollback(1) == 1
            assert "summaries" not in mm.table_names()
            assert mm.migrate() == 2
            assert "summaries" in mm.table_names()


class TestSchemaDeterministicIDs:
    def test_document_id_reproducibility(self):
        assert document_id("a.md", "abc") == document_id("a.md", "abc")
        assert document_id("a.md", "abc") != document_id("a.md", "abd")

    def test_chunk_id_reproducibility(self):
        assert chunk_id("doc_x", 0, "hello") == chunk_id("doc_x", 0, "hello")
        assert chunk_id("doc_x", 1, "hello") != chunk_id("doc_x", 0, "hello")

    def test_fact_id_reproducibility(self):
        assert fact_id("Alice", "works_at", "Acme") == fact_id("alice", "WORKS_AT", "acme")

    def test_deterministic_id_detection(self):
        assert is_deterministic_id(document_id("a.md", "abc"))
        assert not is_deterministic_id("random-string")
        assert not is_deterministic_id("doc_zzzz")


class TestCrossSystemLineage:
    def test_lineage_field_generation(self):
        ref = lineage_ref("agentx-memory", "chunk", "chk_ab12")
        assert ref == "agentx-memory:chunk:chk_ab12"
