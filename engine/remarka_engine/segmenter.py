"""Слова → нормализация, предложения, паузы, реплики собеседника (§4.1, §4.4)."""

from __future__ import annotations

import re

from .model import OtherUtterance, RawWord, Sentence, SpeechEvent, Word, fmt_sec
from .spans import Span, overlap_duration

TERMINATORS = ".!?…"
# Граница мысли: конец предложения, запятая, двоеточие, точка с запятой, тире.
BOUNDARY_CHARS = ".!?…,:;—–-"
HESITATION_MIN = 0.3
STRUCTURAL_MIN = 0.8
NO_PUNCT_PAUSE_SPLIT = 0.8  # если ASR без пунктуации — режем на паузах ≥ 0,8 с
HARD_PAUSE_SPLIT = 2.0  # длинная тишина всегда начинает новое предложение
OTHER_UTTERANCE_GAP = 1.0

QUESTION_STARTS = (
    "кто", "что", "как", "почему", "зачем", "сколько", "какой", "какая", "какие", "каким", "какого",
    "какую", "каких", "где", "когда", "куда", "откуда", "чем", "чему", "кого", "кому", "скажите",
    "расскажите", "а что насчет", "а что насчёт", "объясните", "поясните", "правильно ли",
)

_NON_WORD = re.compile(r"[^\w\-]+", re.UNICODE)
_TRAIL_QUOTES = "\"'»)]}"
_LEAD_QUOTES = "\"'«([{"


def normalize_token(text: str) -> str:
    """lower, ё→е, оставить только буквы/цифры/дефис внутри слова."""
    t = text.lower().replace("ё", "е")
    t = _NON_WORD.sub("", t)
    t = t.replace("_", "")
    return t.strip("-")


def _strip_trailing(text: str) -> str:
    return text.rstrip(_TRAIL_QUOTES + " ")


def ends_with_terminator(text: str) -> bool:
    t = _strip_trailing(text)
    return bool(t) and t[-1] in TERMINATORS


def is_question_text(text: str) -> bool:
    return _strip_trailing(text).endswith("?")


def is_thought_boundary(prev_text: str, next_text: str | None = None) -> bool:
    t = _strip_trailing(prev_text)
    if t and t[-1] in BOUNDARY_CHARS:
        return True
    if next_text:
        n = next_text.lstrip(_LEAD_QUOTES + " ")
        if n and n[0] in "—–":
            return True
    return False


def build_words(raw: list[RawWord]) -> list[Word]:
    """RawWord → Word: токены без букв (чистая пунктуация) приклеиваются к предыдущему слову."""
    words: list[Word] = []
    for rw in raw:
        text = rw.text.strip()
        if not text:
            continue
        norm = normalize_token(text)
        if not norm:
            if words:
                words[-1].text = words[-1].text + text
                words[-1].end = max(words[-1].end, rw.end)
            continue
        words.append(Word(i=len(words), start=rw.start, end=max(rw.end, rw.start), text=text, norm=norm, prob=rw.prob))
    return words


def _has_punctuation(words: list[Word]) -> bool:
    n_term = sum(1 for w in words if ends_with_terminator(w.text))
    if n_term == 0:
        return False
    # меньше одной точки на 40 слов — считаем, что пунктуации фактически нет
    return n_term >= max(1, len(words) // 40)


def split_sentences(words: list[Word]) -> list[Sentence]:
    """Предложения по пунктуации; без пунктуации — по паузам ≥ 0,8 с. Проставляет word.sentence_i."""
    sentences: list[Sentence] = []
    if not words:
        return sentences
    punct = _has_punctuation(words)
    start_i = 0
    for k, w in enumerate(words):
        last = k == len(words) - 1
        cut = last
        if not cut:
            gap = words[k + 1].start - w.end
            if punct:
                cut = ends_with_terminator(w.text) or gap >= HARD_PAUSE_SPLIT
            else:
                cut = gap >= NO_PUNCT_PAUSE_SPLIT or ends_with_terminator(w.text)
        if cut:
            chunk = words[start_i : k + 1]
            si = len(sentences)
            for cw in chunk:
                cw.sentence_i = si
            n_words = sum(1 for cw in chunk if cw.kind != "filler")
            sentences.append(
                Sentence(
                    i=si,
                    start=chunk[0].start,
                    end=chunk[-1].end,
                    text=" ".join(cw.text for cw in chunk),
                    word_from=chunk[0].i,
                    word_to=chunk[-1].i,
                    n_words=n_words,
                    is_question=is_question_text(chunk[-1].text),
                )
            )
            start_i = k + 1
    return sentences


def refresh_sentence_counts(words: list[Word], sentences: list[Sentence]) -> None:
    """Пересчитать n_words после разметки филлеров."""
    for s in sentences:
        s.n_words = sum(1 for w in words[s.word_from : s.word_to + 1] if w.kind != "filler")


def find_pauses(words: list[Word], system_speech: list[Span] | None = None) -> list[SpeechEvent]:
    """Паузы между «настоящими» словами (§4.1). Перекрытые речью собеседника — не считаются."""
    system_speech = system_speech or []
    real = [w for w in words if w.kind != "filler"]
    events: list[SpeechEvent] = []
    for a, b in zip(real, real[1:]):
        gap = b.start - a.end
        if gap < HESITATION_MIN:
            continue
        span = Span(a.end, b.start)
        if system_speech:
            ov = overlap_duration(span, system_speech)
            if ov > max(0.1, 0.2 * gap):
                continue
        # Граница мысли — пунктуация ИЛИ граница предложения, выставленная сегментером
        # (без пунктуации ASR предложения режутся по паузам ≥ 0,8 с).
        boundary = is_thought_boundary(a.text, b.text) or a.sentence_i != b.sentence_i
        if gap >= STRUCTURAL_MIN and boundary:
            kind, label = "structural_pause", fmt_sec(gap)
        elif gap >= STRUCTURAL_MIN:
            kind, label = "hesitation_pause", "long"
        elif not boundary:
            kind, label = "hesitation_pause", fmt_sec(gap)
        else:
            continue  # короткая пауза на границе мысли — норма
        events.append(
            SpeechEvent(
                t=a.end,
                end=b.start,
                kind=kind,
                label=label,
                source="asr",
                word_i=b.i,
                sentence_i=b.sentence_i,
                value=gap,
            )
        )
    return events


def split_other_utterances(raw: list[RawWord]) -> list[OtherUtterance]:
    """Реплики собеседника: по паузам ≥ 1 с и по концу предложения (§4.4)."""
    out: list[OtherUtterance] = []
    if not raw:
        return out
    chunk: list[RawWord] = []

    def flush() -> None:
        if not chunk:
            return
        text = " ".join(w.text for w in chunk).strip()
        norm = normalize_token(text.split(" ")[0]) if text else ""
        first_two = " ".join(normalize_token(x) for x in text.split(" ")[:3])
        is_q = is_question_text(text) or norm in QUESTION_STARTS or any(first_two.startswith(q) for q in QUESTION_STARTS if " " in q)
        out.append(OtherUtterance(start=chunk[0].start, end=chunk[-1].end, text=text, is_question=is_q))
        chunk.clear()

    for k, w in enumerate(raw):
        chunk.append(w)
        last = k == len(raw) - 1
        if last:
            flush()
            continue
        gap = raw[k + 1].start - w.end
        if gap >= OTHER_UTTERANCE_GAP or ends_with_terminator(w.text):
            flush()
    return out
