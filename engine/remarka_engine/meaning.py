"""Слой смысла (CONTRACTS.md §5): тип встречи, структура, вопросы собеседника, жаргон,
«три вещи» с дословными цитатами, конспект и договорённости.

Вход — уже собранный dict отчёта (docs/report.schema.json), выход — dict ``Meaning``
из ``src/types/contracts.ts``. Модель НЕ измеряет: ей передаются посчитанные метрики,
события и транскрипт с таймкодами, а она объясняет.

Валидация цитат (риск 04 плана): каждая ``three_things[i].quote`` ищется в
``transcript.words`` нечётко (``difflib.SequenceMatcher`` по norm-токенам, порог 0,8,
окно = длина цитаты ± 3 слова). Не нашлась → рекомендация выбрасывается и
``dropped_things += 1``; нашлась → ``t`` = start первого слова совпадения и ``quote``
заменяется на дословный текст транскрипта. Если после валидации осталось < 3 —
один повтор запроса с указанием на дословность.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Callable, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from .llm import LlmClient, LlmError, load_prompt, log, render_prompt

__all__ = [
    "MEETING_TYPES",
    "ANSWER_KINDS",
    "METRIC_KEYS",
    "MeaningLlmOutput",
    "QuoteMatch",
    "norm_token",
    "match_key",
    "quote_keys",
    "find_quote",
    "validate_three_things",
    "anchor_question",
    "anchor_jargon",
    "fmt_ts",
    "build_transcript_text",
    "compact_metrics",
    "compact_events",
    "build_meaning_prompt",
    "analyze_meaning",
]

MEETING_TYPES: tuple[str, ...] = (
    "pitch", "demo", "sales", "interview", "standup", "lecture", "one_on_one", "training", "other",
)
ANSWER_KINDS: tuple[str, ...] = ("on_topic", "partial", "off_topic", "not_answered")

MEETING_TYPE_LABELS = {
    "pitch": "питч инвестору",
    "demo": "демо клиенту",
    "sales": "продажи / переговоры",
    "interview": "собеседование (я — кандидат)",
    "standup": "стендап команды",
    "lecture": "лекция / доклад / вебинар",
    "one_on_one": "встреча 1:1",
    "training": "тренировка (без созвона)",
    "other": "другое",
}

METRIC_KEYS: frozenset[str] = frozenset(
    f"layer1.{k}"
    for k in (
        "wpm", "articulation_wpm", "filled_pauses_total", "filled_pauses_per_min",
        "crutch_words_total", "crutch_words_per_min", "structural_pauses_per_min",
        "hesitation_pauses_per_min", "talk_ratio", "mean_sentence_len", "long_sentences_share",
        "mtld", "interruptions_by_me", "interruptions_by_other", "my_speech_sec",
        "other_speech_sec", "words_total",
    )
) | frozenset(
    f"layer2.{k}"
    for k in (
        "pitch_median_hz", "pitch_range_st", "phrase_final_decay_db", "rising_statements_share",
        "jitter_pct", "shimmer_pct", "start_jitter_ratio", "loudness_drift_db", "loudness_mean_db",
    )
)

QUOTE_THRESHOLD = 0.8  # порог по norm-токенам (§5)
QUOTE_SLACK = 3  # окно = длина цитаты ± 3 слова
CHAR_THRESHOLD = 0.85  # запасной проход по символам (склейки вроде «э-э»/«ээ»)
MAX_THINGS = 3
MIN_WORDS = 5  # меньше — слой смысла не имеет смысла
TITLE_MAX = 60
ANCHOR_WINDOW_S = 20.0

ProgressFn = Optional[Callable[[int, str], None]]

# ---------------------------------------------------------------------------
# Pydantic-модели ответа модели (то, что возвращает LLM; остальное дописывает движок)
# ---------------------------------------------------------------------------


def _to_seconds(value: Any) -> float:
    """Таймкод из ответа модели → секунды: 83, "83.5", "1:23", "[01:23]"."""
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip().strip("[]() ")
    if ":" in s:
        try:
            parts = [float(p.replace(",", ".")) for p in s.split(":")]
        except ValueError:
            return 0.0
        total = 0.0
        for p in parts:
            total = total * 60 + p
        return total
    try:
        return float(s.replace(",", "."))
    except ValueError:
        return 0.0


def _clamp01(value: Any) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.5
    return max(0.0, min(1.0, v))


def _slug(value: Any) -> str:
    return re.sub(r"[\s\-]+", "_", str(value or "").strip().lower())


MeetingTypeLiteral = Literal[
    "pitch", "demo", "sales", "interview", "standup", "lecture", "one_on_one", "training", "other"
]
AnswerLiteral = Literal["on_topic", "partial", "off_topic", "not_answered"]


class LlmMeetingType(BaseModel):
    type: MeetingTypeLiteral
    confidence: float = 0.5
    reason: str = ""

    @field_validator("type", mode="before")
    @classmethod
    def _norm_type(cls, v: Any) -> str:
        s = _slug(v)
        aliases = {"1_on_1": "one_on_one", "one_to_one": "one_on_one", "1:1": "one_on_one", "1_1": "one_on_one",
                   "negotiation": "sales", "webinar": "lecture", "talk": "lecture", "presentation": "lecture"}
        s = aliases.get(s, s)
        return s if s in MEETING_TYPES else "other"

    @field_validator("confidence", mode="before")
    @classmethod
    def _norm_conf(cls, v: Any) -> float:
        return _clamp01(v)


class LlmStructure(BaseModel):
    kept: bool = True
    comment: str = ""


class LlmQuestion(BaseModel):
    t: float = 0.0
    asked: str
    answered: AnswerLiteral = "partial"
    comment: str = ""

    @field_validator("t", mode="before")
    @classmethod
    def _norm_t(cls, v: Any) -> float:
        return _to_seconds(v)

    @field_validator("answered", mode="before")
    @classmethod
    def _norm_answered(cls, v: Any) -> str:
        s = _slug(v)
        aliases = {"ontopic": "on_topic", "offtopic": "off_topic", "notanswered": "not_answered",
                   "unanswered": "not_answered", "no_answer": "not_answered", "partially": "partial"}
        s = aliases.get(s, s)
        return s if s in ANSWER_KINDS else "partial"


class LlmJargon(BaseModel):
    t: float = 0.0
    term: str
    comment: str = ""

    @field_validator("t", mode="before")
    @classmethod
    def _norm_t(cls, v: Any) -> float:
        return _to_seconds(v)


class LlmThreeThing(BaseModel):
    title: str
    why: str = ""
    quote: str
    instead: str = ""
    metric: Optional[str] = None


class MeaningLlmOutput(BaseModel):
    """Ответ модели на основной запрос слоя смысла."""

    meeting_type: LlmMeetingType
    structure: LlmStructure
    questions: list[LlmQuestion] = Field(default_factory=list)
    jargon: list[LlmJargon] = Field(default_factory=list)
    three_things: list[LlmThreeThing] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Нормализация и поиск цитат
# ---------------------------------------------------------------------------

_HYPHENS = {ord(ch): "-" for ch in "‐‑‒–—−"}
_NON_WORD_RE = re.compile(r"[^\w-]+", re.UNICODE)


def norm_token(token: str) -> str:
    """Норма токена как в §4.1: lower, ё→е, только буквы/цифры/дефис внутри слова."""
    t = str(token).translate(_HYPHENS).lower().replace("ё", "е")
    t = _NON_WORD_RE.sub("", t).replace("_", "")
    return t.strip("-")


def match_key(token: str) -> str:
    """Ключ сравнения: норма без дефисов («э-э» и «ээ» — одно и то же)."""
    return norm_token(token).replace("-", "")


def quote_keys(text: str) -> list[str]:
    return [k for k in (match_key(part) for part in str(text or "").split()) if k]


@dataclass
class QuoteMatch:
    t: float
    word_from: int  # индекс слова в transcript.words (поле i, либо позиция)
    word_to: int
    ratio: float
    text: str  # дословный текст транскрипта на найденном отрезке


def _word_index(words: list[dict[str, Any]]) -> tuple[list[str], list[int]]:
    keys: list[str] = []
    positions: list[int] = []
    for pos, w in enumerate(words):
        k = match_key(w.get("norm") or w.get("text") or "")
        if k:
            keys.append(k)
            positions.append(pos)
    return keys, positions


def _window_lengths(n: int, slack: int) -> list[int]:
    """Длины окон в порядке близости к длине цитаты: n, n-1, n+1, n-2, n+2 …"""
    out = [n]
    for d in range(1, slack + 1):
        if n - d >= 1:
            out.append(n - d)
        out.append(n + d)
    return out


def _best_window(
    query: list[Any],
    keys: list[str],
    lengths: list[int],
    threshold: float,
    as_chars: bool,
) -> tuple[int, int, float] | None:
    """Лучшее окно (start, length, ratio) ≥ threshold; при равенстве — ближе к длине цитаты и раньше."""
    best: tuple[int, int, float] | None = None
    q: Any = " ".join(query) if as_chars else query
    for length in lengths:
        if length > len(keys):
            continue
        for i in range(0, len(keys) - length + 1):
            window: Any = keys[i : i + length]
            if as_chars:
                window = " ".join(window)
            sm = SequenceMatcher(None, q, window, autojunk=False)
            if sm.real_quick_ratio() < threshold or sm.quick_ratio() < threshold:
                continue
            r = sm.ratio()
            if r >= threshold and (best is None or r > best[2] + 1e-9):
                best = (i, length, r)
                if r >= 0.999:
                    return best
    return best


def find_quote(
    words: list[dict[str, Any]],
    quote: str,
    threshold: float = QUOTE_THRESHOLD,
    slack: int = QUOTE_SLACK,
) -> QuoteMatch | None:
    """Нечёткий поиск цитаты по norm-токенам ``transcript.words``.

    Возвращает ``QuoteMatch`` (t = start первого слова совпадения) или None.
    """
    query = quote_keys(quote)
    if not query or not words:
        return None
    keys, positions = _word_index(words)
    if not keys:
        return None
    lengths = _window_lengths(len(query), slack)
    found = _best_window(query, keys, lengths, threshold, as_chars=False)
    if found is None:
        found = _best_window(query, keys, lengths, CHAR_THRESHOLD, as_chars=True)
    if found is None:
        return None
    start, length, ratio = found
    first = words[positions[start]]
    last = words[positions[start + length - 1]]
    p_from, p_to = positions[start], positions[start + length - 1]
    text = " ".join(str(w.get("text") or "") for w in words[p_from : p_to + 1]).strip()
    return QuoteMatch(
        t=float(first.get("start") or 0.0),
        word_from=int(first.get("i", p_from)),
        word_to=int(last.get("i", p_to)),
        ratio=ratio,
        text=text,
    )


def _short_title(title: str) -> str:
    title = " ".join(str(title or "").split())
    if len(title) <= TITLE_MAX:
        return title
    cut = title[: TITLE_MAX - 1]
    if " " in cut[20:]:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,;:—-") + "…"


def _valid_metric(metric: Any) -> str | None:
    if not metric:
        return None
    m = str(metric).strip()
    if m in METRIC_KEYS:
        return m
    for prefix in ("layer1.", "layer2."):  # модель могла дать голое имя
        if prefix + m in METRIC_KEYS:
            return prefix + m
    return None


def validate_three_things(
    words: list[dict[str, Any]],
    things: list[LlmThreeThing],
) -> tuple[list[dict[str, Any]], list[LlmThreeThing]]:
    """Проверяет цитаты. Возвращает (принятые ThreeThing-dict'ы, отброшенные)."""
    kept: list[dict[str, Any]] = []
    dropped: list[LlmThreeThing] = []
    seen_t: set[float] = set()
    for th in things:
        m = find_quote(words, th.quote)
        if m is None:
            dropped.append(th)
            continue
        if m.t in seen_t:  # две рекомендации на одно место — оставляем первую
            dropped.append(th)
            continue
        seen_t.add(m.t)
        kept.append(
            {
                "title": _short_title(th.title),
                "why": th.why.strip(),
                "quote": m.text,
                "t": m.t,
                "instead": th.instead.strip(),
                "metric": _valid_metric(th.metric),
            }
        )
    return kept, dropped


# ---------------------------------------------------------------------------
# Якоря таймкодов для вопросов и жаргона
# ---------------------------------------------------------------------------


def _nearest_sentence_start(report: dict[str, Any], t: float, max_dist: float = ANCHOR_WINDOW_S) -> float:
    sentences = (report.get("transcript") or {}).get("sentences") or []
    best_t, best_d = t, max_dist + 1
    for s in sentences:
        d = abs(float(s.get("start", 0.0)) - t)
        if d < best_d:
            best_t, best_d = float(s.get("start", 0.0)), d
    return best_t if best_d <= max_dist else t


def anchor_question(report: dict[str, Any], asked: str, model_t: float) -> float:
    """``questions[].t``: по тексту реплики собеседника, если она есть; иначе округление по предложению."""
    others = (report.get("transcript") or {}).get("other") or []
    qk = quote_keys(asked)
    qset = {k for k in qk if len(k) > 2} or set(qk)
    best: tuple[float, float, float] | None = None  # (score, -dist, start)
    for u in others:
        uk = quote_keys(u.get("text") or "")
        if not qk or not uk:
            continue
        uset = {k for k in uk if len(k) > 2} or set(uk)
        containment = len(qset & uset) / max(1, len(qset))
        ratio = SequenceMatcher(None, qk, uk, autojunk=False).ratio()
        score = max(containment, ratio)
        if score < 0.5:
            continue
        if u.get("is_question"):
            score += 0.1
        dist = abs(float(u.get("start", 0.0)) - model_t)
        cand = (score, -dist, float(u.get("start", 0.0)))
        if best is None or cand[:2] > best[:2]:
            best = cand
    if best is not None:
        return best[2]
    questions = [u for u in others if u.get("is_question")]
    if questions:
        nearest = min(questions, key=lambda u: abs(float(u.get("start", 0.0)) - model_t))
        if abs(float(nearest.get("start", 0.0)) - model_t) <= ANCHOR_WINDOW_S:
            return float(nearest.get("start", 0.0))
    return _nearest_sentence_start(report, model_t)


def anchor_jargon(report: dict[str, Any], term: str, model_t: float) -> float:
    words = (report.get("transcript") or {}).get("words") or []
    m = find_quote(words, term, threshold=QUOTE_THRESHOLD, slack=1)
    if m is not None:
        return m.t
    return _nearest_sentence_start(report, model_t)


# ---------------------------------------------------------------------------
# Подготовка входа для модели
# ---------------------------------------------------------------------------


def fmt_ts(seconds: float) -> str:
    """``мм:сс`` (или ``ч:мм:сс``), секунды отбрасываются вниз — как позиция в плеере."""
    s = max(0, int(float(seconds or 0.0)))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def _sentence_text(sentence: dict[str, Any], words: list[dict[str, Any]]) -> str:
    """Текст предложения из слов (чтобы цитаты в промпте совпадали с transcript.words)."""
    wf, wt = sentence.get("word_from"), sentence.get("word_to")
    if isinstance(wf, int) and isinstance(wt, int) and 0 <= wf <= wt < len(words):
        parts = [str(w.get("text") or "") for w in words[wf : wt + 1]]
        text = " ".join(p for p in parts if p).strip()
        if text:
            return text
    return str(sentence.get("text") or "").strip()


def build_transcript_text(report: dict[str, Any], other_prefix: str = "СОБЕСЕДНИК: ") -> str:
    """Транскрипт по предложениям ``[mm:ss] текст`` вперемешку с репликами собеседника."""
    tr = report.get("transcript") or {}
    words = tr.get("words") or []
    lines: list[tuple[float, int, str]] = []
    for s in tr.get("sentences") or []:
        text = _sentence_text(s, words)
        if text:
            lines.append((float(s.get("start", 0.0)), 0, f"[{fmt_ts(s.get('start', 0.0))}] {text}"))
    for u in tr.get("other") or []:
        text = str(u.get("text") or "").strip()
        if text:
            lines.append((float(u.get("start", 0.0)), 1, f"[{fmt_ts(u.get('start', 0.0))}] {other_prefix}{text}"))
    if not lines and words:  # нет предложений — сырые слова
        text = " ".join(str(w.get("text") or "") for w in words)
        lines.append((0.0, 0, f"[00:00] {text}"))
    lines.sort(key=lambda x: (x[0], x[1]))
    return "\n".join(line for _, _, line in lines)


def _round(v: Any, nd: int = 2) -> Any:
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return round(float(v), nd)
    return v


def compact_metrics(report: dict[str, Any]) -> dict[str, Any]:
    """Метрики со статусами и ориентирами — компактно для промпта."""
    out: dict[str, Any] = {"metrics": {}}
    metrics = report.get("metrics") or {}
    for layer in ("layer1", "layer2"):
        for key, mv in (metrics.get(layer) or {}).items():
            if key == "crutch_top" or not isinstance(mv, dict) or "value" not in mv:
                continue
            out["metrics"][f"{layer}.{key}"] = {
                "value": _round(mv.get("value")),
                "unit": mv.get("unit", ""),
                "ref": [_round(mv.get("ref_low")), _round(mv.get("ref_high"))],
                "better": mv.get("better"),
                "status": mv.get("status"),
            }
    crutch_top = (metrics.get("layer1") or {}).get("crutch_top") or []
    out["crutch_top"] = [{"word": c.get("word"), "count": c.get("count")} for c in crutch_top[:10]]
    score = report.get("score") or {}
    out["score"] = {"overall": score.get("overall"), "basis": score.get("basis")}
    baseline = report.get("baseline") or {}
    if baseline.get("status") == "ready":
        deltas = sorted(baseline.get("deltas") or [], key=lambda d: -abs(d.get("z") or 0.0))[:6]
        out["baseline_deltas"] = [
            {"metric": d.get("metric"), "baseline": _round(d.get("baseline")), "value": _round(d.get("value")), "z": _round(d.get("z"))}
            for d in deltas
        ]
    else:
        out["baseline"] = "калибровка ещё идёт" if baseline else "нет"
    return out


_HIGHLIGHT_KINDS = (
    "question_from_other", "interruption_by_me", "interruption_by_other", "fast_burst",
    "decay", "rising_statement", "hesitation_pause",
)


def compact_events(report: dict[str, Any], max_highlights: int = 10) -> dict[str, Any]:
    """События сжато: количество по видам, плотность филлеров по минутам, темп по минутам, топ по времени."""
    events = report.get("events") or []
    duration = float((report.get("meeting") or {}).get("duration_sec") or 0.0)
    n_min = max(1, int(duration // 60) + 1)
    counts = Counter(str(e.get("kind")) for e in events)
    fillers_by_min = [0] * n_min
    for e in events:
        if e.get("kind") in ("filled_pause", "crutch"):
            idx = min(n_min - 1, max(0, int(float(e.get("t", 0.0)) // 60)))
            fillers_by_min[idx] += 1
    wpm_points = ((report.get("timeline") or {}).get("wpm")) or []
    wpm_acc: dict[int, list[float]] = {}
    for p in wpm_points:
        v = float(p.get("v") or 0.0)
        if v <= 0:
            continue
        wpm_acc.setdefault(int(float(p.get("t", 0.0)) // 60), []).append(v)
    wpm_by_min = {f"мин {k + 1}": round(sum(v) / len(v)) for k, v in sorted(wpm_acc.items())}
    important = sorted((e for e in events if e.get("kind") in _HIGHLIGHT_KINDS), key=lambda e: float(e.get("t", 0.0)))
    if len(important) > max_highlights:
        step = len(important) / max_highlights
        important = [important[int(i * step)] for i in range(max_highlights)]
    highlights = [
        {"ts": fmt_ts(e.get("t", 0.0)), "t": _round(e.get("t"), 1), "kind": e.get("kind"), "label": e.get("label"), "value": _round(e.get("value"))}
        for e in important
    ]
    return {
        "counts": dict(counts),
        "fillers_and_crutches_by_minute": {f"мин {i + 1}": c for i, c in enumerate(fillers_by_min)},
        "wpm_by_minute": wpm_by_min,
        "highlights": highlights,
    }


def _meeting_type_line(user_meeting_type: str | None) -> str:
    if user_meeting_type in MEETING_TYPES:
        label = MEETING_TYPE_LABELS.get(user_meeting_type, user_meeting_type)
        return (
            f"{user_meeting_type} ({label}) — ЗАДАН ПОЛЬЗОВАТЕЛЕМ, не меняй: верни его же с confidence 1.0."
        )
    return "не задан — определи по содержанию (см. правила), confidence 0..1."


def build_meaning_prompt(report: dict[str, Any], user_meeting_type: str | None = None) -> str:
    meeting = report.get("meeting") or {}
    duration = float(meeting.get("duration_sec") or 0.0)
    has_system = bool(meeting.get("has_system_track"))
    template = load_prompt("meaning_user")
    return render_prompt(
        template,
        meeting_type_line=_meeting_type_line(user_meeting_type),
        duration=fmt_ts(duration),
        has_system="да, реплики собеседника помечены «СОБЕСЕДНИК:»" if has_system else "нет — только моя дорожка",
        title=str(meeting.get("title") or "—"),
        metrics_json=json.dumps(compact_metrics(report), ensure_ascii=False, indent=1),
        events_json=json.dumps(compact_events(report), ensure_ascii=False, indent=1),
        transcript=build_transcript_text(report),
    )


def _retry_prompt(base: str, dropped: list[LlmThreeThing], kept: list[dict[str, Any]]) -> str:
    bad = "\n".join(f"- «{d.quote}»" for d in dropped[:6]) or "- (цитат не было)"
    good = "\n".join(f"- «{k['quote']}»" for k in kept) or "- (нет)"
    return (
        f"{base}\n\n"
        "ПОВТОР. В предыдущем ответе эти цитаты НЕ найдены в транскрипте и были отброшены:\n"
        f"{bad}\n"
        "Цитата должна быть ДОСЛОВНОЙ: скопируй 4–20 подряд идущих слов ровно как в транскрипте выше "
        "(тот же порядок слов, те же «э-э» и слова-паразиты, без исправлений и без многоточий внутри). "
        "Уже принятые цитаты (можно повторить как есть):\n"
        f"{good}\n"
        "Верни снова полный JSON с 3–4 рекомендациями в three_things."
    )


# ---------------------------------------------------------------------------
# Главная функция
# ---------------------------------------------------------------------------


def analyze_meaning(
    report: dict[str, Any],
    client: LlmClient,
    user_meeting_type: str | None = None,
    progress: ProgressFn = None,
) -> dict[str, Any] | None:
    """Строит ``Meaning`` для отчёта. Возвращает None при backend ``none`` или если речи нет.

    ``progress(pct, message)`` — pct 0–100 внутри слоя смысла (0–75 — meaning, 75–100 — summary).
    Бросает ``LlmError``, если основной запрос к модели не удался; вызывающий код
    (cli/report) должен поймать ошибку, записать ``meaning: null`` и предупреждение.
    """
    if client is None or client.backend == "none":
        return None
    words = (report.get("transcript") or {}).get("words") or []
    if len(words) < MIN_WORDS:
        log("слой смысла пропущен: в транскрипте слишком мало слов", "warn")
        return None

    def p(pct: int, message: str) -> None:
        if progress is not None:
            progress(int(pct), message)

    from .summary import summarize  # локальный импорт: summary использует помощники этого модуля

    p(0, "Слой смысла: готовлю транскрипт и метрики")
    system = load_prompt("meaning_system")
    user = build_meaning_prompt(report, user_meeting_type)

    p(5, "Слой смысла: запрос к модели")
    out = client.complete_json(system, user, MeaningLlmOutput)

    p(55, "Слой смысла: проверяю цитаты")
    kept, dropped = validate_three_things(words, out.three_things)
    dropped_total = len(dropped)
    if len(kept) < MAX_THINGS:
        p(60, "Слой смысла: повторный запрос — цитаты должны быть дословными")
        try:
            out2 = client.complete_json(system, _retry_prompt(user, dropped, kept), MeaningLlmOutput)
        except LlmError as exc:
            log(f"повторный запрос слоя смысла не удался: {exc}", "warn")
            out2 = None
        if out2 is not None:
            kept2, dropped2 = validate_three_things(words, out2.three_things)
            known_t = {k["t"] for k in kept}
            for k in kept2:
                if k["t"] not in known_t:
                    kept.append(k)
                    known_t.add(k["t"])
            known_quotes = {d.quote.strip().lower() for d in dropped}
            dropped_total += sum(1 for d in dropped2 if d.quote.strip().lower() not in known_quotes)
            if not out.questions and out2.questions:
                out.questions = out2.questions
            if not out.jargon and out2.jargon:
                out.jargon = out2.jargon
    kept.sort(key=lambda k: k["t"])
    three_things = kept[:MAX_THINGS]  # лишние принятые не считаются «отброшенными за цитату»

    if user_meeting_type in MEETING_TYPES:
        meeting_type = {"type": user_meeting_type, "confidence": 1.0, "reason": "Тип встречи задан пользователем."}
    else:
        meeting_type = {
            "type": out.meeting_type.type,
            "confidence": round(float(out.meeting_type.confidence), 2),
            "reason": out.meeting_type.reason.strip(),
        }

    questions = [
        {
            "t": anchor_question(report, q.asked, q.t),
            "asked": q.asked.strip(),
            "answered": q.answered,
            "comment": q.comment.strip(),
        }
        for q in out.questions[:20]
        if q.asked.strip()
    ]
    questions.sort(key=lambda q: q["t"])
    jargon = [
        {"t": anchor_jargon(report, j.term, j.t), "term": j.term.strip(), "comment": j.comment.strip()}
        for j in out.jargon[:20]
        if j.term.strip()
    ]
    jargon.sort(key=lambda j: j["t"])

    p(75, "Конспект и договорённости")
    try:
        summ = summarize(report, client)
    except LlmError as exc:
        log(f"конспект не построен: {exc}", "warn")
        summ = {"summary": "", "agreements": []}

    p(95, "Слой смысла: собираю результат")
    info = client.describe()
    meaning: dict[str, Any] = {
        "backend": info["backend"],
        "model": info["model"],
        "meeting_type": meeting_type,
        "structure": {"kept": bool(out.structure.kept), "comment": out.structure.comment.strip()},
        "questions": questions,
        "jargon": jargon,
        "three_things": three_things,
        "dropped_things": int(dropped_total),
        "summary": str(summ.get("summary") or ""),
        "agreements": list(summ.get("agreements") or []),
    }
    p(100, "Слой смысла готов")
    return meaning
