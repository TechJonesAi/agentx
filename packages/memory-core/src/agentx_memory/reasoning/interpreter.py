"""QueryInterpreter: classify the query, extract keywords/entities, decide
precision mode and graph expansion — all deterministic, no LLM in the loop."""

from __future__ import annotations

import re

from .types import QueryIntent, QueryType

_STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "do", "does", "did",
    "what", "when", "where", "who", "why", "how", "which", "whom", "whose",
    "in", "on", "at", "of", "for", "to", "from", "with", "by", "about", "between",
    "and", "or", "not", "no", "my", "your", "our", "their", "his", "her", "its",
    "me", "you", "we", "they", "it", "this", "that", "these", "those", "there",
    "please", "tell", "show", "find", "give", "can", "could", "would", "should",
}

_TYPE_RULES: list[tuple[QueryType, re.Pattern[str]]] = [
    (QueryType.COMPARISON, re.compile(
        r"\b(compare|versus|vs\.?|difference between|differ|better than|worse than)\b", re.I)),
    (QueryType.TIMELINE, re.compile(
        r"\b(timeline|chronolog|sequence of events|history of|when did|what happened (on|in|after|before))\b", re.I)),
    (QueryType.PROCEDURE, re.compile(
        r"\b(how (do|to|can|should) (i|we|you)|steps to|procedure|process for|instructions)\b", re.I)),
    (QueryType.EXPLANATION, re.compile(
        r"\b(why|explain|reason for|how does .+ work|what causes)\b", re.I)),
    # Case matters only for the [A-Z] entity anchor; the verbs are (?i:).
    (QueryType.ENTITY_LOOKUP, re.compile(
        r"\b((?i:who is|who was)|(?i:what is) [A-Z]|(?i:tell me about) [A-Z]|(?i:details (?:about|on|for)))\b")),
    (QueryType.FACT, re.compile(
        r"\b(when (is|was|does)|what date|how (much|many|long)|what is the (amount|number|date|deadline|value|rate)|exact)\b", re.I)),
]

_ENTITY_RX = re.compile(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b")
_TIME_RECENT_RX = re.compile(r"\b(recent|recently|last (week|month|year)|latest|newest|yesterday|today)\b", re.I)
_TIME_RANGE_RX = re.compile(r"\b(in|during|between|since)\s+(19|20)\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b", re.I)


def classify_query(query: str) -> QueryType:
    for qtype, rx in _TYPE_RULES:
        if rx.search(query):
            return qtype
    return QueryType.GENERAL


def extract_keywords(query: str) -> list[str]:
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9'-]{1,}", query.lower())
    seen: list[str] = []
    for w in words:
        if w not in _STOPWORDS and w not in seen:
            seen.append(w)
    return seen


_OPENER_WORDS = _STOPWORDS | {
    "tell", "who", "what", "when", "where", "why", "how", "did", "does", "has",
    "have", "will", "explain", "compare", "summarise", "summarize", "list",
}


def extract_entities(query: str) -> list[str]:
    """Capitalized multi/single-word spans. Leading question-opener words
    ("Did Penny Smith…") are stripped from the front of a span rather than
    disqualifying it."""
    entities: list[str] = []
    for m in _ENTITY_RX.finditer(query):
        words = m.group(1).split()
        while words and words[0].lower() in _OPENER_WORDS:
            words.pop(0)
        span = " ".join(words)
        if span and span not in entities:
            entities.append(span)
    return entities


class QueryInterpreter:
    def interpret(self, query: str) -> QueryIntent:
        qtype = classify_query(query)
        entities = extract_entities(query)
        time_scope = None
        if _TIME_RECENT_RX.search(query):
            time_scope = "recent"
        elif _TIME_RANGE_RX.search(query):
            time_scope = "range"
        return QueryIntent(
            query=query,
            query_type=qtype,
            keywords=extract_keywords(query),
            entities=entities,
            time_scope=time_scope,
            # Fact queries demand tight retrieval — precision over recall.
            high_precision=qtype is QueryType.FACT,
            # Entity/comparison questions benefit from walking the graph.
            needs_graph_expansion=bool(entities) and qtype in (
                QueryType.ENTITY_LOOKUP, QueryType.COMPARISON, QueryType.TIMELINE),
        )
