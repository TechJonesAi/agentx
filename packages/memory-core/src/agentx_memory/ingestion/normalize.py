"""Text normalization: unicode, whitespace, control characters.

Runs between parsing and chunking so chunk IDs (content-derived) are stable
across cosmetic differences in source encoding.
"""

from __future__ import annotations

import re
import unicodedata

from .types import Section

_CONTROL_RX = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_MULTI_SPACE_RX = re.compile(r"[ \t]{2,}")
_MULTI_NEWLINE_RX = re.compile(r"\n{3,}")


def normalize_unicode(text: str) -> str:
    """NFKC-fold, normalize quotes/dashes to ASCII equivalents."""
    text = unicodedata.normalize("NFKC", text)
    for src, dst in (("‘", "'"), ("’", "'"), ("“", '"'), ("”", '"'),
                     ("–", "-"), ("—", "-"), (" ", " ")):
        text = text.replace(src, dst)
    return text


def strip_control_chars(text: str) -> str:
    return _CONTROL_RX.sub("", text)


def normalize_whitespace(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _MULTI_SPACE_RX.sub(" ", text)
    text = _MULTI_NEWLINE_RX.sub("\n\n", text)
    return text.strip()


def clean_text(text: str) -> str:
    """Full pipeline: unicode → control chars → whitespace."""
    return normalize_whitespace(strip_control_chars(normalize_unicode(text)))


class Normalizer:
    """Applies clean_text to every section, dropping ones that normalize to empty."""

    def normalize(self, sections: list[Section]) -> list[Section]:
        out: list[Section] = []
        for s in sections:
            cleaned = clean_text(s.text)
            if not cleaned:
                continue
            out.append(Section(heading=s.heading, text=cleaned, level=s.level,
                               heading_path=s.heading_path))
        return out
