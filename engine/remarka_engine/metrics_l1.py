"""Слой 1 (§4.1): темп, паузы, филлеры, костыли, доля речи, перебивания, MTLD, предложения."""

from __future__ import annotations

from dataclasses import dataclass, field

from .crutches import crutch_top
from .model import MetricValue, Sentence, SpeechEvent, Word
from .references import metric_value
from .spans import Span, intersect, merge_gaps, subtract, total
from .timeline import TimelineResult

MTLD_TTR = 0.72
MTLD_MIN_WORDS = 50
LONG_SENTENCE_WORDS = 22
INTERRUPTION_OVERLAP = 0.5
INTERRUPTION_PRIOR_SPEECH = 1.0
TURN_GAP = 0.7


@dataclass
class Layer1Inputs:
    words: list[Word]
    sentences: list[Sentence]
    events: list[SpeechEvent]  # все события (паузы, филлеры, костыли, перебивания)
    mic_speech: list[Span]
    system_speech: list[Span]
    has_system: bool
    duration_sec: float
    timeline: TimelineResult | None = None
    extra: dict[str, float] = field(default_factory=dict)


def mtld(tokens: list[str], threshold: float = MTLD_TTR) -> float | None:
    """McCarthy & Jarvis 2010: среднее forward/backward, порог TTR 0,72; < 50 слов → None."""
    if len(tokens) < MTLD_MIN_WORDS:
        return None

    def one_way(seq: list[str]) -> float:
        factors = 0.0
        types: set[str] = set()
        count = 0
        for tok in seq:
            count += 1
            types.add(tok)
            ttr = len(types) / count
            if ttr <= threshold:
                factors += 1
                types = set()
                count = 0
        if count > 0:
            ttr = len(types) / count
            factors += (1 - ttr) / (1 - threshold) if ttr < 1 else 0.0
        return len(seq) / factors if factors > 0 else float(len(seq))

    return (one_way(tokens) + one_way(tokens[::-1])) / 2


def interruptions(mic_speech: list[Span], system_speech: list[Span]) -> list[SpeechEvent]:
    """Пересечение реплик ≥ 0,5 с; перебил тот, кто начал позже, если первый уже говорил ≥ 1 с."""
    if not mic_speech or not system_speech:
        return []
    mine = merge_gaps(mic_speech, TURN_GAP)
    other = merge_gaps(system_speech, TURN_GAP)
    events: list[SpeechEvent] = []
    for m in mine:
        for o in other:
            s = max(m.start, o.start)
            e = min(m.end, o.end)
            if e - s < INTERRUPTION_OVERLAP:
                continue
            if m.start < o.start and o.start - m.start >= INTERRUPTION_PRIOR_SPEECH:
                kind = "interruption_by_other"
            elif o.start < m.start and m.start - o.start >= INTERRUPTION_PRIOR_SPEECH:
                kind = "interruption_by_me"
            else:
                continue
            events.append(SpeechEvent(t=s, end=e, kind=kind, label=f"{e - s:.1f}".replace(".", ",") + " с", source="signal", value=e - s))
    events.sort(key=lambda ev: ev.t)
    return events


def active_seconds(mic_speech: list[Span], system_speech: list[Span]) -> float:
    """«Моё активное время»: от первого до последнего моего слова/сегмента минус время, где говорит только собеседник."""
    if not mic_speech:
        return 0.0
    span = Span(mic_speech[0].start, mic_speech[-1].end)
    other_only = subtract(system_speech, mic_speech)
    return max(0.0, span.duration - total(intersect([span], other_only)))


def compute(inp: Layer1Inputs, meeting_type: str) -> tuple[dict[str, MetricValue], list[dict]]:
    words = inp.words
    real = [w for w in words if w.kind != "filler"]
    n_words = len(real)
    counts: dict[str, int] = {}
    for e in inp.events:
        counts[e.kind] = counts.get(e.kind, 0) + 1
    active = active_seconds(inp.mic_speech, inp.system_speech)
    minutes = active / 60.0 if active > 0 else 0.0

    def per_min(n: int) -> float | None:
        return (n / minutes) if minutes > 0 else None

    my_sec = total(inp.mic_speech)
    other_sec = total(inp.system_speech) if inp.has_system else None
    talk_ratio = None
    if inp.has_system and other_sec is not None and (my_sec + other_sec) > 0:
        talk_ratio = my_sec / (my_sec + other_sec)

    wpm = inp.timeline.median_wpm() if inp.timeline is not None else None
    art = inp.timeline.median_articulation() if inp.timeline is not None else None
    if wpm is None and n_words >= 5 and minutes > 0:
        wpm = n_words / minutes
    if art is None and n_words > 0 and my_sec > 0:
        art = n_words / (my_sec / 60.0)

    sent = [s for s in inp.sentences if s.n_words > 0]
    mean_len = (sum(s.n_words for s in sent) / len(sent)) if sent else None
    long_share = (sum(1 for s in sent if s.n_words > LONG_SENTENCE_WORDS) / len(sent)) if sent else None
    lex = mtld([w.norm for w in real])

    has_speech = n_words > 0
    m: dict[str, MetricValue] = {
        "wpm": metric_value("wpm", wpm if has_speech else None, meeting_type),
        "articulation_wpm": metric_value("articulation_wpm", art if has_speech else None, meeting_type),
        "filled_pauses_total": metric_value("filled_pauses_total", counts.get("filled_pause", 0) if has_speech else None, meeting_type),
        "filled_pauses_per_min": metric_value("filled_pauses_per_min", per_min(counts.get("filled_pause", 0)) if has_speech else None, meeting_type),
        "crutch_words_total": metric_value("crutch_words_total", counts.get("crutch", 0) if has_speech else None, meeting_type),
        "crutch_words_per_min": metric_value("crutch_words_per_min", per_min(counts.get("crutch", 0)) if has_speech else None, meeting_type),
        "structural_pauses_per_min": metric_value("structural_pauses_per_min", per_min(counts.get("structural_pause", 0)) if has_speech else None, meeting_type),
        "hesitation_pauses_per_min": metric_value("hesitation_pauses_per_min", per_min(counts.get("hesitation_pause", 0)) if has_speech else None, meeting_type),
        "talk_ratio": metric_value("talk_ratio", talk_ratio, meeting_type),
        "mean_sentence_len": metric_value("mean_sentence_len", mean_len, meeting_type),
        "long_sentences_share": metric_value("long_sentences_share", long_share, meeting_type),
        "mtld": metric_value("mtld", lex, meeting_type),
        "interruptions_by_me": metric_value("interruptions_by_me", counts.get("interruption_by_me", 0) if inp.has_system else None, meeting_type),
        "interruptions_by_other": metric_value("interruptions_by_other", counts.get("interruption_by_other", 0) if inp.has_system else None, meeting_type),
        "my_speech_sec": metric_value("my_speech_sec", my_sec, meeting_type),
        "other_speech_sec": metric_value("other_speech_sec", other_sec, meeting_type),
        "words_total": metric_value("words_total", n_words, meeting_type),
    }
    return m, crutch_top(inp.events)
