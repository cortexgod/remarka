"""Операции над временными отрезками [start, end) в секундах."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Span:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def to_dict(self) -> dict[str, float]:
        return {"start": round(self.start, 3), "end": round(self.end, 3)}


def total(spans: list[Span]) -> float:
    return float(sum(s.duration for s in spans))


def normalize(spans: list[Span]) -> list[Span]:
    """Сортировка и слияние перекрывающихся/касающихся отрезков."""
    out: list[Span] = []
    for s in sorted(spans, key=lambda x: (x.start, x.end)):
        if s.end <= s.start:
            continue
        if out and s.start <= out[-1].end:
            if s.end > out[-1].end:
                out[-1] = Span(out[-1].start, s.end)
        else:
            out.append(s)
    return out


def merge_gaps(spans: list[Span], max_gap: float) -> list[Span]:
    """Слить отрезки, между которыми промежуток < max_gap (получаем «реплики»)."""
    out: list[Span] = []
    for s in normalize(spans):
        if out and s.start - out[-1].end < max_gap:
            out[-1] = Span(out[-1].start, max(out[-1].end, s.end))
        else:
            out.append(s)
    return out


def intersect(a: list[Span], b: list[Span]) -> list[Span]:
    a = normalize(a)
    b = normalize(b)
    out: list[Span] = []
    i = j = 0
    while i < len(a) and j < len(b):
        s = max(a[i].start, b[j].start)
        e = min(a[i].end, b[j].end)
        if e > s:
            out.append(Span(s, e))
        if a[i].end < b[j].end:
            i += 1
        else:
            j += 1
    return out


def subtract(a: list[Span], b: list[Span]) -> list[Span]:
    """a \\ b."""
    a = normalize(a)
    b = normalize(b)
    out: list[Span] = []
    for s in a:
        cur_start = s.start
        for t in b:
            if t.end <= cur_start:
                continue
            if t.start >= s.end:
                break
            if t.start > cur_start:
                out.append(Span(cur_start, t.start))
            cur_start = max(cur_start, t.end)
            if cur_start >= s.end:
                break
        if cur_start < s.end:
            out.append(Span(cur_start, s.end))
    return out


def clip(spans: list[Span], start: float, end: float) -> list[Span]:
    return intersect(spans, [Span(start, end)])


def overlap_duration(s: Span, spans: list[Span]) -> float:
    return total(intersect([s], spans))


def covers(spans: list[Span], t: float) -> bool:
    return any(s.start <= t < s.end for s in spans)
