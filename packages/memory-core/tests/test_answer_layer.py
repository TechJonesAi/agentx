"""Answer layer: relevance gate thresholds + answer generation contract.

Model calls are mocked — no network in unit tests.
"""

from unittest.mock import patch

from agentx_memory.answer.gate import GateThresholds, RelevanceGate
from agentx_memory.answer.generator import AnswerGenerator, extract_citations, truncate_context
from agentx_memory.reasoning.context_builder import ContextBuilder
from agentx_memory.reasoning.interpreter import extract_keywords
from agentx_memory.reasoning.types import (
    ContextPack,
    EvidenceCluster,
    EvidenceTier,
    QueryIntent,
    RetrievedEvidence,
)


def _pack(texts_scores=(("four weeks notice period applies", 0.8),
                        ("the notice period is four weeks per policy", 0.7)),
          query="notice period weeks", clusters=2, tiers=None, reason=""):
    intent = QueryIntent(query=query, keywords=extract_keywords(query))
    evidence = []
    for i, (t, s) in enumerate(texts_scores):
        tier = (tiers or {}).get(i, EvidenceTier.RAW)
        evidence.append(RetrievedEvidence(chunk_id=f"c{i}", doc_id=f"d{i % max(clusters,1)}",
                                          text=t, score=s, tier=tier,
                                          heading_path=f"Doc > Sec{i % max(clusters,1)}"))
    cl = [EvidenceCluster(key=f"k{j}", axis="document",
                          evidence=[e for e in evidence if e.doc_id == f"d{j}"])
          for j in range(clusters)]
    pack = ContextBuilder(4000).build(intent, evidence, [c for c in cl if c.evidence])
    pack.reason = reason
    return pack


class TestRelevanceGate:
    def test_high_score_passes(self):
        assert RelevanceGate().evaluate(_pack()).passed

    def test_empty_evidence_fails(self):
        pack = ContextPack(query="x", intent=QueryIntent(query="x"))
        r = RelevanceGate().evaluate(pack)
        assert not r.passed and "no evidence" in r.reason

    def test_low_top_score_fails(self):
        r = RelevanceGate().evaluate(_pack((("four weeks notice text", 0.1),)))
        assert not r.passed and "top score" in r.reason

    def test_low_avg_top_k_fails(self):
        r = RelevanceGate().evaluate(_pack(
            (("notice period weeks", 0.4), ("x", 0.05), ("y", 0.05))))
        assert not r.passed and "avg top-" in r.reason

    def test_zero_keyword_overlap_fails(self):
        r = RelevanceGate().evaluate(_pack((("completely unrelated content", 0.9),)))
        assert not r.passed and "keyword overlap" in r.reason

    def test_corroborating_clusters_required(self):
        r = RelevanceGate().evaluate(_pack(clusters=1))
        assert not r.passed and "corroboration" in r.reason

    def test_summary_tier_required(self):
        # Single cluster BUT summary-tier evidence present → corroborated.
        r = RelevanceGate().evaluate(_pack(clusters=1, tiers={0: EvidenceTier.SUMMARY}))
        assert r.passed

    def test_custom_thresholds(self):
        gate = RelevanceGate(GateThresholds(min_top_score=0.95))
        assert not gate.evaluate(_pack()).passed


class TestAnswerGenerator:
    def test_generates_answer(self):
        gen = AnswerGenerator()
        with patch.object(gen, "_chat", return_value="Four weeks [C1]."):
            res = gen.answer(_pack())
        assert res.status == "answered" and res.citations == [1]

    def test_citation_regex(self):
        assert extract_citations("See [C1], [C2] and [C2].") == [1, 2]
        assert extract_citations("no citations") == []

    def test_context_truncation(self):
        ctx = "\n\n".join(f"[C{i}] entry text here" for i in range(1, 50))
        out = truncate_context(ctx, 200)
        assert len(out) <= 200 and out.endswith("here")

    def test_prompt_contains_evidence(self):
        gen = AnswerGenerator()
        pack = _pack()
        prompt = gen.build_prompt(pack)
        assert "four weeks notice" in prompt and pack.query in prompt

    def test_empty_evidence_still_works(self):
        gen = AnswerGenerator()
        res = gen.answer(ContextPack(query="x", intent=QueryIntent(query="x")))
        assert res.status == "abstained"

    def test_connection_error_returns_failed(self):
        gen = AnswerGenerator(ollama_url="http://127.0.0.1:1")
        gen.timeout = 0.2
        res = gen.answer(_pack())
        assert res.status == "failed" and res.error

    def test_model_error_returns_failed(self):
        gen = AnswerGenerator()
        with patch.object(gen, "_chat", side_effect=RuntimeError("model exploded")):
            res = gen.answer(_pack())
        assert res.status == "failed" and "model exploded" in res.error


class TestAnswerIntegration:
    def test_relevant_query_produces_answer(self, cfg, conn, ingested_doc, embedder):
        from agentx_memory.reasoning.engine import ReasoningEngine
        from agentx_memory.reasoning.summaries import SummaryGenerator
        SummaryGenerator(conn).generate_all(ingested_doc.doc_id)
        pack = ReasoningEngine(cfg, conn, embedder=embedder).query(
            "How much notice before dismissal?")
        gen = AnswerGenerator()
        with patch.object(gen, "_chat", return_value="Four weeks [C1]."):
            res = gen.answer(pack)
        assert res.status == "answered"

    def test_irrelevant_query_abstains(self, cfg, conn, ingested_doc, embedder):
        from agentx_memory.reasoning.engine import ReasoningEngine
        pack = ReasoningEngine(cfg, conn, embedder=embedder).query(
            "boiling point of tungsten hexafluoride")
        assert AnswerGenerator().answer(pack).status == "abstained"

    def test_disabled_returns_retrieval_only(self):
        res = AnswerGenerator(enabled=False).answer(_pack())
        assert res.status == "retrieval_only" and res.context_pack is not None

    def test_existing_reason_returns_context_pack(self):
        res = AnswerGenerator().answer(_pack(reason="smalltalk short-circuit"))
        assert res.status == "retrieval_only"

    def test_context_pack_preserved_in_answered_query(self):
        gen = AnswerGenerator()
        pack = _pack()
        with patch.object(gen, "_chat", return_value="Answer [C1]."):
            res = gen.answer(pack)
        assert res.context_pack is pack
