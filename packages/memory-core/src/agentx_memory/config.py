"""Configuration + bootstrap for the AgentX Memory API.

Bootstrap is idempotent: it creates the data folders, writes default config
files if absent, validates the memory config, and initializes the DuckDB
schema via the migration framework. Safe to run on every service start.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

VALID_PROVIDERS = ("ollama", "mock")
VALID_DIMENSIONS = (256, 384, 512, 768, 1024, 1536, 3072)

DEFAULT_DATA_DIR = Path(os.environ.get("AGENTX_MEMORY_DATA_DIR", "~/.agentx/memory")).expanduser()


class ConfigError(ValueError):
    """Raised when a memory config fails validation."""


@dataclass
class MemoryConfig:
    """Validated configuration for the memory service."""

    data_dir: Path = field(default_factory=lambda: DEFAULT_DATA_DIR)
    embedding_provider: str = "ollama"
    embedding_model: str = "nomic-embed-text"
    embedding_dimensions: int = 768
    ollama_url: str = "http://127.0.0.1:11434"
    answer_model: str = "qwen3:30b-a3b-instruct-2507-q4_K_M"
    answer_enabled: bool = True
    chunk_target_tokens: int = 350
    chunk_max_tokens: int = 512
    context_token_budget: int = 4000

    def __post_init__(self) -> None:
        self.data_dir = Path(self.data_dir).expanduser()
        if self.embedding_provider not in VALID_PROVIDERS:
            raise ConfigError(
                f"Invalid embedding provider {self.embedding_provider!r}; "
                f"expected one of {VALID_PROVIDERS}"
            )
        if self.embedding_dimensions not in VALID_DIMENSIONS:
            raise ConfigError(
                f"Invalid embedding dimensions {self.embedding_dimensions}; "
                f"expected one of {VALID_DIMENSIONS}"
            )
        if self.chunk_target_tokens <= 0 or self.chunk_max_tokens < self.chunk_target_tokens:
            raise ConfigError("chunk_max_tokens must be >= chunk_target_tokens > 0")

    # ── paths ────────────────────────────────────────────────────────────
    @property
    def db_path(self) -> Path:
        return self.data_dir / "memory.duckdb"

    @property
    def vectors_dir(self) -> Path:
        return self.data_dir / "vectors"

    @property
    def inbox_dir(self) -> Path:
        return self.data_dir / "inbox"

    @property
    def archive_dir(self) -> Path:
        return self.data_dir / "archive"

    @property
    def config_path(self) -> Path:
        return self.data_dir / "memory-config.yaml"

    def to_dict(self) -> dict[str, Any]:
        return {
            "data_dir": str(self.data_dir),
            "embedding_provider": self.embedding_provider,
            "embedding_model": self.embedding_model,
            "embedding_dimensions": self.embedding_dimensions,
            "ollama_url": self.ollama_url,
            "answer_model": self.answer_model,
            "answer_enabled": self.answer_enabled,
            "chunk_target_tokens": self.chunk_target_tokens,
            "chunk_max_tokens": self.chunk_max_tokens,
            "context_token_budget": self.context_token_budget,
        }


def load_config(data_dir: Path | None = None) -> MemoryConfig:
    """Load config from <data_dir>/memory-config.yaml, or defaults if absent."""
    base = Path(data_dir).expanduser() if data_dir else DEFAULT_DATA_DIR
    cfg_path = base / "memory-config.yaml"
    if cfg_path.exists():
        raw = yaml.safe_load(cfg_path.read_text()) or {}
        raw.pop("data_dir", None)  # location is authoritative, not the file
        return MemoryConfig(data_dir=base, **raw)
    return MemoryConfig(data_dir=base)


def bootstrap(config: MemoryConfig | None = None) -> MemoryConfig:
    """Create folders + default config file + database schema. Idempotent."""
    cfg = config or load_config()
    for d in (cfg.data_dir, cfg.vectors_dir, cfg.inbox_dir, cfg.archive_dir):
        d.mkdir(parents=True, exist_ok=True)
    if not cfg.config_path.exists():
        cfg.config_path.write_text(yaml.safe_dump(cfg.to_dict(), sort_keys=False))
    # Schema init lives with the migration framework (import here to avoid cycles)
    from .schema import MigrationManager

    with MigrationManager(cfg) as mm:
        mm.migrate()
    return cfg
