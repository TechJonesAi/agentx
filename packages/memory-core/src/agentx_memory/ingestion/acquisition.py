"""Acquisition layer: checksums, source-type detection, duplicate detection."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import duckdb

SOURCE_TYPES = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".txt": "text",
    ".json": "transcript-json",
    ".jsonl": "transcript-jsonl",
    ".eml": "email",
    ".pdf": "pdf",
    ".html": "html",
    ".htm": "html",
}


def compute_checksum(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def detect_source_type(path: str | Path) -> str:
    return SOURCE_TYPES.get(Path(path).suffix.lower(), "unknown")


@dataclass
class AcquiredSource:
    source_path: str
    source_type: str
    checksum: str
    byte_size: int
    raw_text: str
    is_duplicate: bool = False


class AcquisitionLayer:
    """Reads a source file, fingerprints it, and flags exact duplicates."""

    def __init__(self, conn: duckdb.DuckDBPyConnection):
        self.conn = conn

    def is_duplicate(self, checksum: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM documents WHERE checksum = ? LIMIT 1", [checksum]
        ).fetchone()
        return row is not None

    def acquire(self, path: str | Path) -> AcquiredSource:
        p = Path(path)
        raw = p.read_bytes()
        checksum = compute_checksum(raw)
        return AcquiredSource(
            source_path=str(p),
            source_type=detect_source_type(p),
            checksum=checksum,
            byte_size=len(raw),
            raw_text=raw.decode("utf-8", errors="replace"),
            is_duplicate=self.is_duplicate(checksum),
        )

    def acquire_text(self, text: str, source_path: str, source_type: str = "text") -> AcquiredSource:
        """Acquire in-memory content (API ingestion) without touching disk."""
        checksum = compute_checksum(text)
        return AcquiredSource(
            source_path=source_path,
            source_type=source_type,
            checksum=checksum,
            byte_size=len(text.encode("utf-8")),
            raw_text=text,
            is_duplicate=self.is_duplicate(checksum),
        )
