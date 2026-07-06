"""agentx_memory — AgentX Memory API core.

Rebuilt 2026-07 (original source lost pre-restore). Four layers:

  config     — bootstrap, folders, validated MemoryConfig
  schema     — deterministic IDs, DuckDB schema, migration framework
  ingestion  — acquire → parse → normalize → chunk → embed → store (resumable)
  reasoning  — interpret → retrieve (hybrid) → rerank → cluster → context pack
  answer     — relevance gate (abstains) → cited answer generation
  api        — FastAPI service on :8100 (supervised by the AgentX web server)

Storage: DuckDB (chunks, documents, summaries, graph, control plane) +
LanceDB (vectors). Embeddings: Ollama nomic-embed-text (768-dim), the same
model the TypeScript core uses, so vectors are comparable across systems.
"""

__version__ = "2.0.0"
