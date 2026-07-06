"""Semantic chunking: sentence-aware grouping under a token budget.

Chunk IDs are deterministic (doc + ordinal + text), so re-running the
pipeline on unchanged content produces identical chunks — storage layers
can then skip duplicates instead of accumulating copies.
"""

from __future__ import annotations

import hashlib
import re

from ..schema import chunk_id as make_chunk_id
from .types import Chunk, Section

_SENTENCE_RX = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])")


def estimate_tokens(text: str) -> int:
    """Fast heuristic: ~4 chars/token for English prose, floor of word count."""
    return max(len(text) // 4, len(text.split()))


def split_into_sentences(text: str) -> list[str]:
    parts = [p.strip() for p in _SENTENCE_RX.split(text) if p.strip()]
    return parts or ([text.strip()] if text.strip() else [])


def group_sentences(sentences: list[str], target_tokens: int, max_tokens: int) -> list[str]:
    """Greedy grouping: fill up to target, never exceed max (single long
    sentences pass through whole — never split mid-sentence)."""
    groups: list[str] = []
    current: list[str] = []
    current_tokens = 0
    for s in sentences:
        st = estimate_tokens(s)
        if current and current_tokens + st > max_tokens:
            groups.append(" ".join(current))
            current, current_tokens = [], 0
        current.append(s)
        current_tokens += st
        if current_tokens >= target_tokens:
            groups.append(" ".join(current))
            current, current_tokens = [], 0
    if current:
        groups.append(" ".join(current))
    return groups


class SemanticChunker:
    def __init__(self, target_tokens: int = 350, max_tokens: int = 512):
        self.target_tokens = target_tokens
        self.max_tokens = max_tokens

    def chunk_sections(self, doc_id: str, sections: list[Section]) -> list[Chunk]:
        chunks: list[Chunk] = []
        ordinal = 0
        for section in sections:
            for group in group_sentences(
                split_into_sentences(section.text), self.target_tokens, self.max_tokens
            ):
                text = group.strip()
                if not text:
                    continue
                chunks.append(Chunk(
                    chunk_id=make_chunk_id(doc_id, ordinal, text),
                    doc_id=doc_id,
                    ordinal=ordinal,
                    text=text,
                    text_hash=hashlib.sha256(text.encode("utf-8")).hexdigest()[:24],
                    heading_path=section.heading_path,
                    token_count=estimate_tokens(text),
                ))
                ordinal += 1
        return chunks

    def chunk_transcript(self, doc_id: str, sections: list[Section]) -> list[Chunk]:
        """Transcripts chunk per grouped turns — same mechanics, kept as a
        separate entry point so turn boundaries are never merged across
        speakers when budgets are small."""
        return self.chunk_sections(doc_id, sections)
