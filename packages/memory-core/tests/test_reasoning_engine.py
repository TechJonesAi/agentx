"""Reasoning engine: interpreter, retrievers, reranker, clusterer, context
builder, summaries, end-to-end pipeline, audit."""

import pytest

from agentx_memory.reasoning.clusterer import EvidenceClusterer
from agentx_memory.reasoning.context_builder import ContextBuilder
from agentx_memory.reasoning.engine import ReasoningEngine
from agentx_memory.reasoning.interpreter import QueryInterpreter, extract_entities, extract_keywords
from agentx_memory.reasoning.reranker import HybridReranker, keyword_score, structural_score
from agentx_memory.reasoning.retrievers import (
    CanonicalChunkRetriever,
    EpisodicRetriever,
    GraphExpander,
    GraphRetriever,
    RawEvidenceRetriever,
    SummaryRetriever,
)
from agentx_memory.reasoning.summaries import SummaryGenerator
from agentx_memory.reasoning.types import (
    ContextPack,
    EvidenceCluster,
    EvidenceStance,
    EvidenceTier,
    QueryIntent,
    QueryType,
    RankingWeights,
    RetrievedEvidence,
)


def _intent(query="notice period dismissal", **over):
    base = QueryIntent(query=query, keywords=extract_keywords(query))
    for k, v in over.items():
        setattr(base, k, v)
    return base


def _ev(cid="c1", text="four weeks notice", score=0.5, tier=EvidenceTier.RAW,
        heading="Contract > Termination", doc="d1"):
    return RetrievedEvidence(chunk_id=cid, doc_id=doc, text=text, score=score,
                             tier=tier, heading_path=heading)


class TestQueryInterpreter:
    interp = QueryInterpreter()

    def test_classify_fact(self):
        assert self.interp.interpret("What is the exact deadline date?").query_type is QueryType.FACT

    def test_classify_comparison(self):
        assert self.interp.interpret("Compare contract A versus contract B").query_type is QueryType.COMPARISON

    def test_classify_entity_lookup(self):
        assert self.interp.interpret("Who is Penny Smith?").query_type is QueryType.ENTITY_LOOKUP

    def test_classify_explanation(self):
        assert self.interp.interpret("Explain why the claim failed").query_type is QueryType.EXPLANATION

    def test_classify_procedure(self):
        assert self.interp.interpret("How do I submit an ET1 form?").query_type is QueryType.PROCEDURE

    def test_classify_timeline(self):
        assert self.interp.interpret("Give me the timeline of the dispute").query_type is QueryType.TIMELINE

    def test_classify_general(self):
        assert self.interp.interpret("dismissal evidence").query_type is QueryType.GENERAL

    def test_extract_keywords(self):
        kws = extract_keywords("What is the notice period for dismissal?")
        assert "notice" in kws and "dismissal" in kws and "what" not in kws

    def test_extract_entities(self):
        ents = extract_entities("Did Penny Smith email Brixton Council?")
        assert "Penny Smith" in ents and "Brixton Council" in ents

    def test_interpret_full(self):
        i = self.interp.interpret("Who is Penny Smith?")
        assert i.entities and i.query_type is QueryType.ENTITY_LOOKUP

    def test_interpret_high_precision(self):
        assert self.interp.interpret("What is the exact amount owed?").high_precision

    def test_interpret_graph_expansion_trigger(self):
        assert self.interp.interpret("Who is Penny Smith?").needs_graph_expansion

    def test_interpret_time_scope(self):
        assert self.interp.interpret("recent emails about FTTP").time_scope == "recent"
        assert self.interp.interpret("what happened in March").time_scope == "range"

    def test_interpret_with_entities(self):
        i = self.interp.interpret("Compare Acme Corp and Beta Ltd contracts")
        assert i.needs_graph_expansion


class TestCanonicalChunkRetriever:
    def test_metadata_chunk_search(self, cfg, conn, ingested_doc):
        r = CanonicalChunkRetriever(cfg, conn, embedder=None)
        out = r.retrieve(_intent("salary monthly rate"))
        assert out and any("Salary" in e.heading_path for e in out)

    def test_canonical_boost(self, cfg, conn, ingested_doc, embedder):
        SummaryGenerator(conn).generate_canonical_chunks(ingested_doc.doc_id, top_n=1)
        r = CanonicalChunkRetriever(cfg, conn, embedder=None)
        out = r.retrieve(_intent("notice dismissal employer"))
        canon = [e for e in out if e.tier is EvidenceTier.CANONICAL]
        raw = [e for e in out if e.tier is EvidenceTier.RAW]
        if canon and raw:
            assert canon[0].score > raw[0].score

    def test_deduplication_by_hash(self, cfg, conn, ingested_doc):
        r = CanonicalChunkRetriever(cfg, conn, embedder=None)
        out = r.retrieve(_intent("notice dismissal"))
        assert len({e.chunk_id for e in out}) == len(out)

    def test_narrowing_by_doc_ids(self, cfg, conn, ingested_doc, pipeline):
        pipeline.ingest_text("Unrelated salary discussion elsewhere.", "other.txt", "text")
        r = CanonicalChunkRetriever(cfg, conn, embedder=None)
        out = r.retrieve(_intent("salary"), doc_ids=[ingested_doc.doc_id])
        assert out and all(e.doc_id == ingested_doc.doc_id for e in out)


class TestSummaryRetriever:
    def test_metadata_search(self, cfg, conn, ingested_doc):
        SummaryGenerator(conn).generate_all(ingested_doc.doc_id)
        out = SummaryRetriever(conn).retrieve(_intent("salary monthly"))
        assert out and all(e.tier is EvidenceTier.SUMMARY for e in out)

    def test_deduplication(self, cfg, conn, ingested_doc):
        SummaryGenerator(conn).generate_all(ingested_doc.doc_id)
        out = SummaryRetriever(conn).retrieve(_intent("notice salary employer"))
        assert len({e.chunk_id for e in out}) == len(out)

    def test_returns_empty_when_no_summaries_table(self, cfg, conn):
        conn.execute("DROP TABLE summaries")
        assert SummaryRetriever(conn).retrieve(_intent()) == []


class TestRawEvidenceRetriever:
    def test_retrieve_by_chunk_ids(self, conn, ingested_doc):
        cid = conn.execute("SELECT chunk_id FROM chunks LIMIT 1").fetchone()[0]
        out = RawEvidenceRetriever(conn).by_chunk_ids([cid])
        assert out[0].chunk_id == cid

    def test_retrieve_empty_ids(self, conn):
        assert RawEvidenceRetriever(conn).by_chunk_ids([]) == []

    def test_retrieve_with_context_window(self, conn, ingested_doc):
        cid = conn.execute("SELECT chunk_id FROM chunks WHERE ordinal=0").fetchone()[0]
        with_ctx = RawEvidenceRetriever(conn).by_chunk_ids([cid], context_window=1)
        without = RawEvidenceRetriever(conn).by_chunk_ids([cid])
        assert len(with_ctx) > len(without)

    def test_retrieve_without_context(self, conn, ingested_doc):
        cid = conn.execute("SELECT chunk_id FROM chunks LIMIT 1").fetchone()[0]
        assert len(RawEvidenceRetriever(conn).by_chunk_ids([cid], context_window=0)) == 1

    def test_retrieve_by_document(self, conn, ingested_doc):
        out = RawEvidenceRetriever(conn).by_document(ingested_doc.doc_id)
        assert len(out) == ingested_doc.chunk_count

    def test_retrieve_by_heading_path(self, conn, ingested_doc):
        out = RawEvidenceRetriever(conn).by_heading_path("Employment Contract > Salary")
        assert out and all("Salary" in e.heading_path for e in out)


class TestEpisodicRetriever:
    def test_retrieve_episodes_by_keyword(self, conn):
        conn.execute("INSERT INTO episodes (episode_id, text) VALUES ('e1',"
                     " 'We discussed the dismissal case yesterday')")
        out = EpisodicRetriever(conn).retrieve(_intent("dismissal case"))
        assert out and out[0].tier is EvidenceTier.EPISODIC

    def test_retrieve_episodes_no_match(self, conn):
        assert EpisodicRetriever(conn).retrieve(_intent("zzz qqq")) == []

    def test_graceful_no_episodes_table(self, conn):
        conn.execute("DROP TABLE episodes")
        assert EpisodicRetriever(conn).retrieve(_intent()) == []


class TestGraphRetriever:
    def test_get_entity_mentions(self, cfg, conn):
        from agentx_memory.ingestion.storage import StorageWriter
        sw = StorageWriter(cfg, conn)
        sw.store_graph_node("ent_penny", "entity", "Penny Smith")
        sw.store_graph_edge("ent_penny", "chk_x", "mentions")
        g = GraphRetriever(conn)
        nodes = g.find_entities(["Penny"])
        assert nodes == ["ent_penny"]
        assert g.get_entity_mentions(nodes) == ["chk_x"]

    def test_find_entities_graceful_failure(self, conn):
        conn.execute("DROP TABLE graph_nodes")
        assert GraphRetriever(conn).find_entities(["x"]) == []

    def test_find_concepts_graceful_failure(self, conn):
        conn.execute("DROP TABLE graph_nodes")
        assert GraphRetriever(conn).find_concepts(["x"]) == []


class TestGraphExpander:
    def test_expand_no_expansion_needed(self, conn):
        out = GraphExpander(conn).expand(_intent(needs_graph_expansion=False), [])
        assert out == []

    def test_expand_with_entities(self, cfg, conn, ingested_doc):
        from agentx_memory.ingestion.storage import StorageWriter
        cid = conn.execute("SELECT chunk_id FROM chunks LIMIT 1").fetchone()[0]
        sw = StorageWriter(cfg, conn)
        sw.store_graph_node("ent_acme", "entity", "Acme")
        sw.store_graph_edge("ent_acme", cid, "mentions")
        intent = _intent(entities=["Acme"], needs_graph_expansion=True)
        out = GraphExpander(conn).expand(intent, [])
        assert out and out[0].tier is EvidenceTier.GRAPH


class TestHybridReranker:
    def test_keyword_score(self):
        assert keyword_score("four weeks notice", ["notice", "weeks"]) == 1.0
        assert keyword_score("nothing relevant", ["notice"]) == 0.0

    def test_structural_score(self):
        i = _intent("termination notice")
        assert structural_score(_ev(heading="Contract > Termination"), i) > 0

    def test_rerank_scores(self):
        i = _intent("notice weeks")
        evs = [_ev("a", "irrelevant text", 0.9, heading=""),
               _ev("b", "four weeks notice period", 0.5)]
        out = HybridReranker().rerank(evs, i)
        assert out[0].chunk_id == "b"

    def test_rerank_graph_boost(self):
        i = _intent("zzz")
        evs = [_ev("a", "same text", 0.3, tier=EvidenceTier.RAW, heading=""),
               _ev("b", "same text", 0.3, tier=EvidenceTier.GRAPH, heading="")]
        out = HybridReranker().rerank(evs, i)
        assert out[0].chunk_id == "b"

    def test_rerank_empty(self):
        assert HybridReranker().rerank([], _intent()) == []


class TestEvidenceClusterer:
    c = EvidenceClusterer()

    def test_cluster_by_document(self):
        i = _intent(query_type=QueryType.COMPARISON)
        out = self.c.cluster([_ev("a", doc="d1"), _ev("b", doc="d2")], i)
        assert {cl.key for cl in out} == {"d1", "d2"}
        assert all(cl.axis == "document" for cl in out)

    def test_cluster_by_heading(self):
        out = self.c.cluster([_ev("a"), _ev("b", heading="Policy > Leave")], _intent())
        assert all(cl.axis == "heading" for cl in out)

    def test_cluster_by_tier(self):
        evs = [_ev("a", heading=""), _ev("b", heading="", tier=EvidenceTier.SUMMARY)]
        out = self.c.cluster(evs, _intent())
        assert all(cl.axis == "tier" for cl in out)

    def test_auto_axis_selection(self):
        assert self.c.select_axis(_intent(query_type=QueryType.COMPARISON), []) == "document"
        assert self.c.select_axis(_intent(), [_ev("a", heading="")]) == "tier"

    def test_detect_conflicts(self):
        evs = [_ev("a", "The notice period is 4 weeks"),
               _ev("b", "The notice period is not 4 weeks, it was denied")]
        out = self.c.cluster(evs, _intent())
        assert any(cl.has_conflict for cl in out)
        assert any(e.stance is EvidenceStance.CONFLICTS for e in evs)

    def test_empty_evidence(self):
        assert self.c.cluster([], _intent()) == []


class TestContextBuilder:
    def test_build_basic(self):
        pack = ContextBuilder(1000).build(_intent(), [_ev()], [])
        assert "[C1]" in pack.context_text
        assert pack.evidence

    def test_token_budget_respected(self):
        evs = [_ev(f"c{i}", "word " * 100) for i in range(20)]
        pack = ContextBuilder(300).build(_intent(), evs, [])
        assert pack.token_count <= 300
        assert len(pack.evidence) < 20

    def test_lineage_refs_built(self):
        pack = ContextBuilder(1000).build(_intent(), [_ev("c9")], [])
        assert pack.lineage_refs == ["agentx-memory:chunk:c9"]

    def test_episodic_context_included(self):
        ep = _ev("e1", "we discussed this before", tier=EvidenceTier.EPISODIC, heading="")
        pack = ContextBuilder(1000).build(_intent(), [_ev()], [], episodic=[ep])
        assert "episodic" in pack.context_text


class TestSummaryGenerator:
    def test_generate_document_summary(self, conn, ingested_doc):
        sid = SummaryGenerator(conn).generate_document_summary(ingested_doc.doc_id)
        assert sid and sid.startswith("sum_")

    def test_generate_section_summaries(self, conn, ingested_doc):
        out = SummaryGenerator(conn).generate_section_summaries(ingested_doc.doc_id)
        assert len(out) >= 2

    def test_generate_canonical_chunks(self, conn, ingested_doc):
        ids = SummaryGenerator(conn).generate_canonical_chunks(ingested_doc.doc_id, top_n=1)
        tier = conn.execute("SELECT tier FROM chunks WHERE chunk_id=?", [ids[0]]).fetchone()[0]
        assert tier == "canonical"

    def test_summary_idempotent(self, conn, ingested_doc):
        g = SummaryGenerator(conn)
        g.generate_document_summary(ingested_doc.doc_id)
        g.generate_document_summary(ingested_doc.doc_id)
        n = conn.execute("SELECT count(*) FROM summaries WHERE scope='document'").fetchone()[0]
        assert n == 1

    def test_deterministic_summary_ids(self, conn, ingested_doc):
        g = SummaryGenerator(conn)
        a = g.generate_document_summary(ingested_doc.doc_id)
        b = g.generate_document_summary(ingested_doc.doc_id)
        assert a == b


class TestReasoningTypes:
    def test_query_type_values(self):
        assert QueryType("fact") is QueryType.FACT

    def test_evidence_tier_values(self):
        assert EvidenceTier("canonical") is EvidenceTier.CANONICAL

    def test_evidence_stance_values(self):
        assert EvidenceStance("conflicts") is EvidenceStance.CONFLICTS

    def test_query_intent_defaults(self):
        i = QueryIntent(query="x")
        assert i.query_type is QueryType.GENERAL and not i.high_precision

    def test_retrieved_evidence_defaults(self):
        assert _ev().stance is EvidenceStance.NEUTRAL

    def test_ranking_weights_defaults(self):
        w = RankingWeights()
        assert abs(w.vector + w.keyword + w.structural + w.graph - 1.0) < 1e-9

    def test_context_pack_defaults(self):
        p = ContextPack(query="x")
        assert p.evidence == [] and p.token_count == 0


class TestEndToEndReasoning:
    def test_full_pipeline_returns_context_pack(self, cfg, conn, ingested_doc, embedder):
        pack = ReasoningEngine(cfg, conn, embedder=embedder).query(
            "How much notice before dismissal?")
        assert isinstance(pack, ContextPack) and pack.evidence

    def test_pipeline_with_data(self, cfg, conn, ingested_doc, embedder):
        pack = ReasoningEngine(cfg, conn, embedder=embedder).query("salary rate monthly")
        assert any("Salary" in e.heading_path for e in pack.evidence)

    def test_pipeline_handles_empty_results(self, cfg, conn, embedder):
        pack = ReasoningEngine(cfg, conn, embedder=embedder).query("zzz qqq xyzzy")
        assert isinstance(pack, ContextPack)

    def test_clusters_generated(self, cfg, conn, ingested_doc, embedder):
        pack = ReasoningEngine(cfg, conn, embedder=embedder).query(
            "notice period and salary details")
        assert pack.clusters

    def test_fact_query_triggers_high_precision(self, cfg, conn, ingested_doc, embedder):
        pack = ReasoningEngine(cfg, conn, embedder=embedder).query(
            "What is the exact salary amount?")
        assert pack.intent.high_precision

    def test_lineage_tracking(self, cfg, conn, ingested_doc, embedder):
        pack = ReasoningEngine(cfg, conn, embedder=embedder).query("notice dismissal")
        assert all(r.startswith("agentx-memory:chunk:") for r in pack.lineage_refs)


class TestRetrievalAudit:
    def test_audit_write(self, cfg, conn, ingested_doc, embedder):
        ReasoningEngine(cfg, conn, embedder=embedder).query("notice dismissal")
        n = conn.execute("SELECT count(*) FROM retrieval_audit").fetchone()[0]
        assert n == 1


class TestMigration0002:
    def test_migration_creates_tables(self, cfg):
        from agentx_memory.schema import MigrationManager
        with MigrationManager(cfg) as mm:
            assert {"summaries", "graph_nodes", "graph_edges", "episodes",
                    "retrieval_audit"} <= mm.table_names()

    def test_migration_rollback(self, tmp_path):
        from agentx_memory.config import MemoryConfig, bootstrap
        from agentx_memory.schema import MigrationManager
        cfg = bootstrap(MemoryConfig(data_dir=tmp_path / "m2"))
        with MigrationManager(cfg) as mm:
            mm.rollback(1)
            assert "graph_nodes" not in mm.table_names()
