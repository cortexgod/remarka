"""Структуры данных движка (зеркало contracts.ts, snake_case)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

WordKind = Literal["word", "filler", "crutch"]
EventSource = Literal["asr", "detector", "both", "signal", "llm"]


@dataclass
class RawWord:
    """Слово от ASR до нормализации."""

    start: float
    end: float
    text: str
    prob: float


@dataclass
class Word:
    i: int
    start: float
    end: float
    text: str
    norm: str
    prob: float
    kind: WordKind = "word"
    sentence_i: int = 0

    @property
    def is_real(self) -> bool:
        """«Настоящее» слово — не филлер (костыль тоже слово)."""
        return self.kind != "filler"

    def to_dict(self) -> dict[str, Any]:
        return {
            "i": self.i,
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "text": self.text,
            "norm": self.norm,
            "prob": round(float(self.prob), 3),
            "kind": self.kind,
            "sentence_i": self.sentence_i,
        }


@dataclass
class Sentence:
    i: int
    start: float
    end: float
    text: str
    word_from: int
    word_to: int
    n_words: int
    is_question: bool

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def to_dict(self) -> dict[str, Any]:
        return {
            "i": self.i,
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "text": self.text,
            "word_from": self.word_from,
            "word_to": self.word_to,
            "n_words": self.n_words,
            "is_question": self.is_question,
        }


@dataclass
class OtherUtterance:
    start: float
    end: float
    text: str
    is_question: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "text": self.text,
            "is_question": self.is_question,
        }


@dataclass
class SpeechEvent:
    t: float
    end: float
    kind: str
    label: str
    source: EventSource
    word_i: int | None = None
    sentence_i: int | None = None
    value: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "t": round(self.t, 3),
            "end": round(self.end, 3),
            "kind": self.kind,
            "label": self.label,
            "source": self.source,
            "word_i": self.word_i,
            "sentence_i": self.sentence_i,
            "value": None if self.value is None else round(float(self.value), 3),
        }


@dataclass
class MetricValue:
    value: float | None
    unit: str
    ref_low: float | None
    ref_high: float | None
    better: Literal["inside", "higher", "lower"]
    status: Literal["good", "warn", "bad", "na"]

    def to_dict(self) -> dict[str, Any]:
        return {
            "value": None if self.value is None else round(float(self.value), 4),
            "unit": self.unit,
            "ref_low": self.ref_low,
            "ref_high": self.ref_high,
            "better": self.better,
            "status": self.status,
        }


@dataclass
class TimePoint:
    t: float
    v: float

    def to_dict(self) -> dict[str, float]:
        return {"t": round(self.t, 3), "v": round(float(self.v), 3)}


@dataclass
class Transcript:
    words: list[Word] = field(default_factory=list)
    sentences: list[Sentence] = field(default_factory=list)
    other: list[OtherUtterance] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "words": [w.to_dict() for w in self.words],
            "sentences": [s.to_dict() for s in self.sentences],
            "other": [o.to_dict() for o in self.other],
        }


def fmt_sec(x: float) -> str:
    """«1,2 с» — человекочитаемая длительность с запятой."""
    return f"{x:.1f}".replace(".", ",") + " с"


def fmt_signed(x: float, unit: str, digits: int = 1) -> str:
    s = f"{x:+.{digits}f}".replace(".", ",")
    return f"{s} {unit}"
