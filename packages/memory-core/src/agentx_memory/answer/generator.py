"""AnswerGenerator: grounded, cited answers via Ollama chat.

Contract:
  • Answers cite evidence as [C1], [C2] … matching the context pack.
  • Evidence beyond the char budget is truncated, never silently dropped
    mid-citation (truncation happens at entry boundaries).
  • Any model/connection error returns status='failed' with the context
    pack preserved — the caller can still show retrieval-only results.
  • answer() with the layer disabled, or a pack that already has a
    short-circuit reason, returns retrieval-only immediately.
  • An abstention (gate failure) returns status='abstained' with the reason.
"""

from __future__ import annotations

import json
import re
import urllib.request
from dataclasses import dataclass, field

from ..reasoning.types import ContextPack
from .gate import GateResult, RelevanceGate

CITATION_RX = re.compile(r"\[C(\d+)\]")

_SYSTEM_PROMPT = (
    "You answer questions using ONLY the provided evidence. Cite evidence"
    " inline as [C1], [C2] etc. If the evidence does not contain the answer,"
    " say so plainly. Never invent facts beyond the evidence."
)


@dataclass
class AnswerResult:
    status: str                     # 'answered' | 'abstained' | 'failed' | 'retrieval_only'
    answer: str = ""
    citations: list[int] = field(default_factory=list)
    gate: GateResult | None = None
    context_pack: ContextPack | None = None
    error: str | None = None


def extract_citations(text: str) -> list[int]:
    return sorted({int(m) for m in CITATION_RX.findall(text)})


def truncate_context(context_text: str, max_chars: int) -> str:
    """Truncate at evidence-entry boundaries ('\n\n'), never mid-entry."""
    if len(context_text) <= max_chars:
        return context_text
    entries = context_text.split("\n\n")
    out: list[str] = []
    used = 0
    for e in entries:
        if used + len(e) + 2 > max_chars:
            break
        out.append(e)
        used += len(e) + 2
    return "\n\n".join(out) if out else context_text[:max_chars]


class AnswerGenerator:
    def __init__(self, ollama_url: str = "http://127.0.0.1:11434",
                 model: str = "qwen3:30b-a3b-instruct-2507-q4_K_M",
                 enabled: bool = True, max_context_chars: int = 24000,
                 timeout: float = 120.0, gate: RelevanceGate | None = None):
        self.ollama_url = ollama_url.rstrip("/")
        self.model = model
        self.enabled = enabled
        self.max_context_chars = max_context_chars
        self.timeout = timeout
        self.gate = gate or RelevanceGate()

    def build_prompt(self, pack: ContextPack) -> str:
        ctx = truncate_context(pack.context_text, self.max_context_chars)
        return f"EVIDENCE:\n{ctx}\n\nQUESTION: {pack.query}\n\nANSWER (with [Cn] citations):"

    def _chat(self, prompt: str) -> str:
        req = urllib.request.Request(
            f"{self.ollama_url}/api/chat",
            data=json.dumps({
                "model": self.model,
                "messages": [
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                "stream": False,
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        return str(payload.get("message", {}).get("content", "")).strip()

    def answer(self, pack: ContextPack) -> AnswerResult:
        if not self.enabled:
            return AnswerResult(status="retrieval_only", context_pack=pack)
        if pack.reason:  # pipeline short-circuited upstream (e.g. smalltalk)
            return AnswerResult(status="retrieval_only", context_pack=pack)

        gate = self.gate.evaluate(pack)
        if not gate.passed:
            return AnswerResult(status="abstained", gate=gate, context_pack=pack,
                                answer=f"No sufficient evidence: {gate.reason}")

        try:
            text = self._chat(self.build_prompt(pack))
        except Exception as exc:  # noqa: BLE001 — connection/model errors → failed
            return AnswerResult(status="failed", gate=gate, context_pack=pack,
                                error=str(exc))
        if not text:
            return AnswerResult(status="failed", gate=gate, context_pack=pack,
                                error="model returned empty answer")
        return AnswerResult(status="answered", answer=text,
                            citations=extract_citations(text),
                            gate=gate, context_pack=pack)
