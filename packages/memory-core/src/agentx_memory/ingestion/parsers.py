"""Parsers: markdown, plain text, and transcript JSON/JSONL → Sections.

Markdown parsing maintains a hierarchical heading stack so each section
carries its full path ("Contract > Termination > Notice periods") — that
path is preserved onto chunks and is a first-class retrieval axis.
"""

from __future__ import annotations

import json
import re

from .types import Section


class UnknownSourceTypeError(ValueError):
    pass


class HeadingStack:
    """Tracks the current hierarchical heading path while scanning markdown."""

    def __init__(self) -> None:
        self._stack: list[tuple[int, str]] = []  # (level, heading)

    def push(self, level: int, heading: str) -> None:
        # Pop anything at the same or deeper level, then push.
        while self._stack and self._stack[-1][0] >= level:
            self._stack.pop()
        self._stack.append((level, heading))

    def current_path(self) -> str:
        return " > ".join(h for _, h in self._stack)


_MD_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


def parse_md(text: str) -> list[Section]:
    sections: list[Section] = []
    stack = HeadingStack()
    matches = list(_MD_HEADING.finditer(text))
    if not matches:
        return [Section(heading="", text=text.strip(), level=0, heading_path="")]

    preamble = text[: matches[0].start()].strip()
    if preamble:
        sections.append(Section(heading="", text=preamble, level=0, heading_path=""))

    for i, m in enumerate(matches):
        level = len(m.group(1))
        heading = m.group(2).strip()
        stack.push(level, heading)
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[m.end(): body_end].strip()
        sections.append(
            Section(heading=heading, text=body, level=level, heading_path=stack.current_path())
        )
    return sections


def parse_txt(text: str) -> list[Section]:
    """Plain text: blank-line-separated blocks become one section each; the
    first line acts as a pseudo-heading so heading_path is never empty."""
    stripped = text.strip()
    if not stripped:
        return []
    first_line = stripped.splitlines()[0][:80].strip()
    return [Section(heading=first_line, text=stripped, level=0, heading_path=first_line)]


def parse_transcript_json(text: str) -> list[Section]:
    """Transcript: JSON array of {speaker, text, [timestamp]} turns."""
    data = json.loads(text)
    if isinstance(data, dict) and "turns" in data:
        data = data["turns"]
    if not isinstance(data, list):
        raise ValueError("transcript JSON must be a list of turns")
    sections: list[Section] = []
    for i, turn in enumerate(data):
        speaker = str(turn.get("speaker", f"speaker-{i}"))
        body = str(turn.get("text", "")).strip()
        if not body:
            continue
        heading = f"{speaker}"
        sections.append(
            Section(heading=heading, text=f"{speaker}: {body}", level=1, heading_path=heading)
        )
    return sections


def parse_transcript_jsonl(text: str) -> list[Section]:
    turns = [json.loads(line) for line in text.splitlines() if line.strip()]
    return parse_transcript_json(json.dumps(turns))


PARSERS = {
    "markdown": parse_md,
    "text": parse_txt,
    "email": parse_txt,
    "transcript-json": parse_transcript_json,
    "transcript-jsonl": parse_transcript_jsonl,
}


def parse_document(text: str, source_type: str) -> list[Section]:
    """Dispatch to the right parser; unknown types raise (caller records FAILED)."""
    parser = PARSERS.get(source_type)
    if parser is None:
        raise UnknownSourceTypeError(f"No parser for source type {source_type!r}")
    return parser(text)
