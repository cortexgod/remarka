"""Слова-костыли: словарь n-грамм по norm, условные слова (§4.1)."""

from __future__ import annotations

from collections import Counter
from functools import lru_cache

from .model import Sentence, SpeechEvent, Word
from .references import load_data


@lru_cache(maxsize=1)
def _dict() -> tuple[dict[int, set[str]], set[str], float]:
    data = load_data("crutch_words.json")
    by_len: dict[int, set[str]] = {}
    for phrase in data["phrases"]:
        toks = tuple(phrase.split())
        by_len.setdefault(len(toks), set()).add(" ".join(toks))
    conditional = set(data.get("conditional", []))
    return by_len, conditional, float(data.get("min_pause_sec", 0.2))


def detect_crutches(words: list[Word], sentences: list[Sentence]) -> list[SpeechEvent]:
    """Помечает kind=crutch на первом слове фразы и возвращает события crutch (label = фраза)."""
    by_len, conditional, min_pause = _dict()
    if not words:
        return []
    real = [w for w in words if w.kind != "filler"]
    sentence_starts = {s.word_from for s in sentences}
    # начало предложения: первое «настоящее» слово предложения
    first_real_of_sentence: set[int] = set()
    seen: set[int] = set()
    for w in real:
        if w.sentence_i not in seen:
            seen.add(w.sentence_i)
            first_real_of_sentence.add(w.i)
    events: list[SpeechEvent] = []
    max_n = max(by_len) if by_len else 1
    k = 0
    while k < len(real):
        matched = False
        for n in range(min(max_n, len(real) - k), 0, -1):
            phrase = " ".join(real[k + j].norm for j in range(n))
            if phrase not in by_len.get(n, set()):
                continue
            first = real[k]
            last = real[k + n - 1]
            if phrase in conditional:
                prev_gap = first.start - real[k - 1].end if k > 0 else 99.0
                next_gap = real[k + n].start - last.end if k + n < len(real) else 99.0
                at_start = first.i in first_real_of_sentence or first.i in sentence_starts
                if not (at_start or prev_gap >= min_pause or next_gap >= min_pause):
                    continue
            first.kind = "crutch"
            events.append(
                SpeechEvent(t=first.start, end=last.end, kind="crutch", label=phrase, source="asr", word_i=first.i, sentence_i=first.sentence_i, value=None)
            )
            k += n
            matched = True
            break
        if not matched:
            k += 1
    return events


def crutch_top(events: list[SpeechEvent], limit: int = 10) -> list[dict[str, object]]:
    c = Counter(e.label for e in events if e.kind == "crutch")
    return [{"word": w, "count": n} for w, n in c.most_common(limit)]
