"""Ingestion pipeline: acquisition, parsers, normalization, chunking,
embedding, storage, resumable jobs, graph writes."""

import json

import pytest

from agentx_memory.ingestion.acquisition import AcquisitionLayer, compute_checksum, detect_source_type
from agentx_memory.ingestion.chunking import (
    SemanticChunker,
    estimate_tokens,
    group_sentences,
    split_into_sentences,
)
from agentx_memory.ingestion.embedding import MockEmbedder, validate_batch
from agentx_memory.ingestion.normalize import (
    Normalizer,
    clean_text,
    normalize_unicode,
    normalize_whitespace,
    strip_control_chars,
)
from agentx_memory.ingestion.parsers import (
    UnknownSourceTypeError,
    parse_document,
    parse_md,
    parse_transcript_json,
    parse_transcript_jsonl,
    parse_txt,
)
from agentx_memory.ingestion.pipeline import can_resume
from agentx_memory.ingestion.storage import StorageWriter
from agentx_memory.ingestion.types import (
    Chunk,
    IngestionResult,
    IngestionStage,
    IngestionStatus,
    Section,
)


class TestAcquisition:
    def test_compute_checksum(self):
        assert compute_checksum("abc") == compute_checksum(b"abc")
        assert compute_checksum("abc") != compute_checksum("abd")

    def test_detect_source_type(self):
        assert detect_source_type("x.md") == "markdown"
        assert detect_source_type("x.jsonl") == "transcript-jsonl"
        assert detect_source_type("x.xyz") == "unknown"

    def test_acquisition_layer(self, conn, tmp_path):
        f = tmp_path / "note.md"
        f.write_text("# Hi\nBody")
        src = AcquisitionLayer(conn).acquire(f)
        assert src.source_type == "markdown"
        assert src.byte_size > 0
        assert not src.is_duplicate

    def test_duplicate_detection(self, pipeline, conn):
        pipeline.ingest_text("Some text content here.", "a.txt", "text")
        src = AcquisitionLayer(conn).acquire_text("Some text content here.", "b.txt")
        assert src.is_duplicate


class TestParsers:
    def test_parse_md(self):
        sections = parse_md("# A\nintro\n## B\nbody")
        assert [s.heading for s in sections] == ["A", "B"]
        assert sections[1].heading_path == "A > B"

    def test_parse_txt(self):
        sections = parse_txt("First line heading\nrest of it")
        assert sections[0].heading == "First line heading"

    def test_parse_transcript_json(self):
        turns = json.dumps([{"speaker": "Darren", "text": "Hello"},
                            {"speaker": "Agent", "text": "Hi there"}])
        sections = parse_transcript_json(turns)
        assert len(sections) == 2
        assert sections[0].text.startswith("Darren:")

    def test_parse_transcript_jsonl(self):
        lines = '{"speaker": "A", "text": "one"}\n{"speaker": "B", "text": "two"}'
        assert len(parse_transcript_jsonl(lines)) == 2

    def test_parse_document_dispatcher(self):
        assert parse_document("# H\nx", "markdown")[0].heading == "H"

    def test_parse_document_unknown_type(self):
        with pytest.raises(UnknownSourceTypeError):
            parse_document("data", "spreadsheet")


class TestNormalization:
    def test_normalize_unicode(self):
        assert normalize_unicode("“smart” – quotes") == '"smart" - quotes'

    def test_strip_control_chars(self):
        assert strip_control_chars("a\x00b\x1fc") == "abc"

    def test_normalize_whitespace(self):
        assert normalize_whitespace("a  b\r\n\n\n\nc") == "a b\n\nc"

    def test_clean_text_full_pipeline(self):
        assert clean_text("“a”\x00  b") == '"a" b'

    def test_normalizer_class(self):
        out = Normalizer().normalize([Section("H", "  text  "), Section("E", "\x00")])
        assert len(out) == 1 and out[0].text == "text"

    def test_normalizer_markdown(self):
        out = Normalizer().normalize(parse_md("# A\n\n“body”\n"))
        assert out[0].text == '"body"'

    def test_normalizer_transcript(self):
        sections = parse_transcript_json('[{"speaker":"A","text":"hi\\u0000there"}]')
        out = Normalizer().normalize(sections)
        assert "\x00" not in out[0].text


class TestChunking:
    def test_estimate_tokens(self):
        assert estimate_tokens("four word test here") >= 4

    def test_split_into_sentences(self):
        s = split_into_sentences("One. Two! Three?")
        assert len(s) == 3

    def test_group_sentences(self):
        groups = group_sentences(["short one."] * 10, target_tokens=6, max_tokens=10)
        assert len(groups) > 1

    def test_chunk_sections(self):
        chunks = SemanticChunker(50, 80).chunk_sections(
            "doc_x", [Section("H", "A sentence here. " * 20, heading_path="H")])
        assert len(chunks) > 1
        assert all(c.heading_path == "H" for c in chunks)
        assert [c.ordinal for c in chunks] == list(range(len(chunks)))

    def test_chunk_transcript(self):
        sections = parse_transcript_json('[{"speaker":"A","text":"hello world"}]')
        chunks = SemanticChunker().chunk_transcript("doc_t", sections)
        assert chunks[0].text.startswith("A:")

    def test_chunk_ids_are_deterministic(self):
        s = [Section("H", "Stable text content.", heading_path="H")]
        a = SemanticChunker().chunk_sections("doc_x", s)
        b = SemanticChunker().chunk_sections("doc_x", s)
        assert [c.chunk_id for c in a] == [c.chunk_id for c in b]

    def test_semantic_chunker_class(self):
        c = SemanticChunker(target_tokens=100, max_tokens=200)
        assert c.target_tokens == 100


class TestEmbedding:
    def test_embedder_with_mock(self):
        emb = MockEmbedder(dimensions=8)
        vecs = emb.embed_batch(["a", "b"])
        assert len(vecs) == 2 and len(vecs[0]) == 8
        assert validate_batch(vecs, 8) == []
        assert validate_batch([[0.0] * 8], 8) == [0]


class TestStorageWriter:
    def test_store_document_metadata(self, cfg, conn, pipeline):
        src = pipeline.acquisition.acquire_text("hello", "h.txt")
        sw = StorageWriter(cfg, conn)
        sw.store_document_metadata("doc_1", src, "Hello")
        sw.store_document_metadata("doc_1", src, "Hello")  # idempotent
        assert conn.execute("SELECT count(*) FROM documents").fetchone()[0] == 1

    def test_store_chunks_duckdb(self, cfg, conn):
        sw = StorageWriter(cfg, conn)
        ch = Chunk("chk_1", "doc_1", 0, "text", "hash1")
        assert sw.store_chunks([ch]) == 1
        assert sw.store_chunks([ch]) == 0  # skip existing


class TestEndToEnd:
    def test_parse_normalize_chunk_pipeline(self, ingested_doc):
        assert ingested_doc.status is IngestionStatus.COMPLETED
        assert ingested_doc.stage is IngestionStage.STORED
        assert ingested_doc.chunk_count >= 2

    def test_parse_normalize_chunk_md(self, conn, ingested_doc):
        paths = [r[0] for r in conn.execute("SELECT heading_path FROM chunks").fetchall()]
        assert any("Termination > Notice periods" in p for p in paths)

    def test_parse_normalize_chunk_transcript(self, pipeline):
        r = pipeline.ingest_text('[{"speaker":"A","text":"hello there everyone"}]',
                                 "t.json", "transcript-json")
        assert r.status is IngestionStatus.COMPLETED

    def test_deterministic_ids_across_runs(self, pipeline, tmp_path):
        r1 = pipeline.ingest_text("Same content.", "same.txt", "text")
        # Re-ingest identical content under the same path — duplicate, same doc id.
        r2 = pipeline.ingest_text("Same content.", "same.txt", "text")
        assert r1.doc_id == r2.doc_id
        assert r2.status is IngestionStatus.DUPLICATE


class TestTypes:
    def test_chunk_dataclass(self):
        c = Chunk("chk", "doc", 0, "t", "h")
        assert c.tier == "raw" and c.embedding is None

    def test_section_dataclass(self):
        assert Section("H", "body").level == 1

    def test_ingestion_result_dataclass(self):
        r = IngestionResult("d", "j", IngestionStatus.COMPLETED, IngestionStage.STORED)
        assert r.chunk_count == 0

    def test_ingestion_stage_values(self):
        assert IngestionStage.order()[0] is IngestionStage.ACQUIRED
        assert IngestionStage.order()[-1] is IngestionStage.STORED

    def test_ingestion_status_values(self):
        assert IngestionStatus("completed") is IngestionStatus.COMPLETED


class TestResumableIngestion:
    def test_can_resume_from_processing(self):
        assert can_resume(IngestionStatus.PROCESSING)

    def test_can_resume_from_failed(self):
        assert can_resume("failed")

    def test_cannot_resume_completed(self):
        assert not can_resume(IngestionStatus.COMPLETED)

    def test_cannot_resume_none_state(self):
        assert not can_resume(None)

    def test_get_job_state_existing(self, pipeline):
        r = pipeline.ingest_text("job state text", "j.txt", "text")
        state = pipeline.get_job_state(r.job_id)
        assert state["status"] is IngestionStatus.COMPLETED

    def test_get_job_state_missing(self, pipeline):
        assert pipeline.get_job_state("job_nope") is None

    def test_stage_order(self):
        order = IngestionStage.order()
        assert order.index(IngestionStage.CHUNKED) < order.index(IngestionStage.EMBEDDED)


class TestGraphIdempotentWrites:
    def test_node_exists_check(self, cfg, conn):
        sw = StorageWriter(cfg, conn)
        assert sw.store_graph_node("n1", "entity", "Alice")
        assert sw.node_exists("n1")

    def test_node_not_exists(self, cfg, conn):
        assert not StorageWriter(cfg, conn).node_exists("missing")

    def test_store_graph_nodes_idempotent(self, cfg, conn):
        sw = StorageWriter(cfg, conn)
        assert sw.store_graph_node("n1", "entity", "Alice")
        assert not sw.store_graph_node("n1", "entity", "Alice")
        assert conn.execute("SELECT count(*) FROM graph_nodes").fetchone()[0] == 1

    def test_edge_exists_check(self, cfg, conn):
        sw = StorageWriter(cfg, conn)
        assert sw.store_graph_edge("a", "b", "mentions")
        assert sw.edge_exists("a", "b", "mentions")
        assert not sw.store_graph_edge("a", "b", "mentions")

    def test_edge_not_exists(self, cfg, conn):
        assert not StorageWriter(cfg, conn).edge_exists("x", "y", "mentions")

    def test_graph_chunk_node_has_empty_text(self, cfg, conn):
        sw = StorageWriter(cfg, conn)
        sw.store_graph_node("chk_1", "chunk", "label", text="SHOULD BE DROPPED")
        assert conn.execute(
            "SELECT text FROM graph_nodes WHERE node_id='chk_1'").fetchone()[0] == ""

    def test_node_exists_handles_exception(self, cfg, conn):
        sw = StorageWriter(cfg, conn)
        conn.execute("DROP TABLE graph_nodes")
        assert sw.node_exists("n1") is False


class TestLanceDBDuplicateProtection:
    def test_get_existing_chunk_ids_empty(self, cfg, conn):
        assert StorageWriter(cfg, conn).get_existing_chunk_ids() == set()

    def test_store_embeddings_skips_duplicates(self, cfg, conn):
        sw = StorageWriter(cfg, conn)
        ch = Chunk("chk_v1", "doc", 0, "text", "h", embedding=[0.1] * 8)
        assert sw.store_embeddings([ch]) == 1
        assert sw.store_embeddings([ch]) == 0

    def test_store_embeddings_skips_zero_vectors(self, cfg, conn):
        sw = StorageWriter(cfg, conn)
        ch = Chunk("chk_v2", "doc", 0, "text", "h", embedding=[0.0] * 8)
        assert sw.store_embeddings([ch]) == 0


class TestHierarchicalHeadingPaths:
    def test_heading_stack_basic(self):
        from agentx_memory.ingestion.parsers import HeadingStack
        st = HeadingStack()
        st.push(1, "A")
        st.push(2, "B")
        assert st.current_path() == "A > B"

    def test_heading_stack_level_pop(self):
        from agentx_memory.ingestion.parsers import HeadingStack
        st = HeadingStack()
        st.push(1, "A"); st.push(2, "B"); st.push(2, "C")
        assert st.current_path() == "A > C"

    def test_heading_stack_chapter_change(self):
        from agentx_memory.ingestion.parsers import HeadingStack
        st = HeadingStack()
        st.push(1, "Ch1"); st.push(2, "S1"); st.push(1, "Ch2")
        assert st.current_path() == "Ch2"

    def test_heading_stack_current_path(self):
        from agentx_memory.ingestion.parsers import HeadingStack
        assert HeadingStack().current_path() == ""

    def test_parse_md_hierarchical_paths(self):
        sections = parse_md("# A\nx\n## B\ny\n### C\nz\n## D\nw")
        paths = [s.heading_path for s in sections]
        assert paths == ["A", "A > B", "A > B > C", "A > D"]

    def test_heading_path_preserved_in_chunks(self, conn, ingested_doc):
        row = conn.execute(
            "SELECT heading_path FROM chunks WHERE heading_path LIKE '%Salary%'").fetchone()
        assert row[0] == "Employment Contract > Salary"

    def test_txt_parser_sets_heading_path(self):
        assert parse_txt("Heading line\nbody")[0].heading_path == "Heading line"


class TestEmbeddingClientReuse:
    def test_lazy_client_creation(self):
        from agentx_memory.ingestion.embedding import OllamaEmbedder
        e = OllamaEmbedder()
        assert e._opener is None
        _ = e.client
        assert e._opener is not None

    def test_client_reused_across_calls(self):
        from agentx_memory.ingestion.embedding import OllamaEmbedder
        e = OllamaEmbedder()
        assert e.client is e.client

    def test_parse_response_dict(self):
        from agentx_memory.ingestion.embedding import OllamaEmbedder
        assert OllamaEmbedder.parse_response({"embeddings": [[1, 2]]}) == [[1.0, 2.0]]
        assert OllamaEmbedder.parse_response({"embedding": [1, 2]}) == [[1.0, 2.0]]

    def test_parse_response_object(self):
        from agentx_memory.ingestion.embedding import OllamaEmbedder

        class R:
            embeddings = [[3, 4]]

        assert OllamaEmbedder.parse_response(R()) == [[3.0, 4.0]]

    def test_embed_text_method(self):
        emb = MockEmbedder(4)
        assert len(emb.embed_text("x")) == 4
