"""Embedding layer: Ollama nomic-embed-text with client reuse + validation.

The HTTP client is created lazily and reused across calls (connection
pooling); embeddings are validated for dimension and zero-vectors before
they ever reach storage.
"""

from __future__ import annotations

import json
import urllib.request
from typing import Any, Callable

EmbedFn = Callable[[list[str]], list[list[float]]]


class EmbeddingError(RuntimeError):
    pass


def validate_embedding(vec: list[float], expected_dim: int) -> bool:
    return len(vec) == expected_dim and any(v != 0.0 for v in vec)


def validate_batch(vectors: list[list[float]], expected_dim: int) -> list[int]:
    """Return indices of INVALID vectors (wrong dim or all-zero)."""
    return [i for i, v in enumerate(vectors) if not validate_embedding(v, expected_dim)]


class OllamaEmbedder:
    """Batch embedder against Ollama's /api/embed. Lazy, reused client."""

    def __init__(
        self,
        url: str = "http://127.0.0.1:11434",
        model: str = "nomic-embed-text",
        dimensions: int = 768,
        timeout: float = 30.0,
    ):
        self.url = url.rstrip("/")
        self.model = model
        self.dimensions = dimensions
        self.timeout = timeout
        self._opener: urllib.request.OpenerDirector | None = None

    @property
    def client(self) -> urllib.request.OpenerDirector:
        if self._opener is None:
            self._opener = urllib.request.build_opener()
        return self._opener

    @staticmethod
    def parse_response(payload: Any) -> list[list[float]]:
        """Accept both dict payloads and objects with an .embeddings attr."""
        if isinstance(payload, dict):
            embs = payload.get("embeddings") or payload.get("embedding")
        else:
            embs = getattr(payload, "embeddings", None)
        if embs is None:
            raise EmbeddingError("No embeddings in response")
        if embs and isinstance(embs[0], (int, float)):
            embs = [embs]  # single-vector form
        return [list(map(float, e)) for e in embs]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        req = urllib.request.Request(
            f"{self.url}/api/embed",
            data=json.dumps({"model": self.model, "input": texts}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        try:
            with self.client.open(req, timeout=self.timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 — every failure maps to EmbeddingError
            raise EmbeddingError(f"Ollama embed failed: {exc}") from exc
        vectors = self.parse_response(payload)
        if len(vectors) != len(texts):
            raise EmbeddingError(f"Expected {len(texts)} vectors, got {len(vectors)}")
        bad = validate_batch(vectors, self.dimensions)
        if bad:
            raise EmbeddingError(f"Invalid embeddings at indices {bad}")
        return vectors

    def embed_text(self, text: str) -> list[float]:
        return self.embed_batch([text])[0]


class MockEmbedder:
    """Deterministic hash-based embedder for tests — no network."""

    def __init__(self, dimensions: int = 768):
        self.dimensions = dimensions
        self.calls = 0

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        self.calls += 1
        out = []
        for t in texts:
            seed = sum(t.encode("utf-8")) or 1
            out.append([((seed * (i + 3)) % 997) / 997.0 + 0.001 for i in range(self.dimensions)])
        return out

    def embed_text(self, text: str) -> list[float]:
        return self.embed_batch([text])[0]
