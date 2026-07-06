"""Shared dataclasses and enums for the ingestion pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class IngestionStage(str, Enum):
    ACQUIRED = "acquired"
    PARSED = "parsed"
    NORMALIZED = "normalized"
    CHUNKED = "chunked"
    EMBEDDED = "embedded"
    STORED = "stored"

    @classmethod
    def order(cls) -> list["IngestionStage"]:
        return [cls.ACQUIRED, cls.PARSED, cls.NORMALIZED, cls.CHUNKED, cls.EMBEDDED, cls.STORED]


class IngestionStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    DUPLICATE = "duplicate"


@dataclass
class Section:
    """A parsed structural unit: heading + body text."""

    heading: str
    text: str
    level: int = 1
    heading_path: str = ""  # "Chapter 1 > Section 1.2 > Subsection"


@dataclass
class Chunk:
    """A stored retrieval unit with deterministic identity."""

    chunk_id: str
    doc_id: str
    ordinal: int
    text: str
    text_hash: str
    heading_path: str = ""
    token_count: int = 0
    tier: str = "raw"
    embedding: list[float] | None = None


@dataclass
class IngestionResult:
    doc_id: str
    job_id: str
    status: IngestionStatus
    stage: IngestionStage
    chunk_count: int = 0
    error: str | None = None
    warnings: list[str] = field(default_factory=list)
