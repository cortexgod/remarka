"""Протокол stdout (JSON lines, §3.1 CONTRACTS.md), логирование в stderr, тайминги, отмена."""

from __future__ import annotations

import json
import signal
import sys
import time
from typing import IO, Any

# Доли стадий в общем прогрессе (§3.1), в порядке выполнения.
STAGE_SHARES: list[tuple[str, int]] = [
    ("load", 2),
    ("vad", 5),
    ("asr", 55),
    ("align", 3),
    ("fillers", 5),
    ("prosody", 10),
    ("metrics", 5),
    ("meaning", 10),
    ("summary", 3),
    ("write", 2),
]
STAGES = [s for s, _ in STAGE_SHARES]

_STAGE_BASE: dict[str, int] = {}
_acc = 0
for _name, _share in STAGE_SHARES:
    _STAGE_BASE[_name] = _acc
    _acc += _share
_STAGE_SHARE = dict(STAGE_SHARES)


class Cancelled(Exception):
    """SIGTERM/SIGINT: движок должен завершиться событием error «cancelled»."""


def install_cancel_handlers() -> None:
    def _handler(signum, frame):  # noqa: ARG001
        raise Cancelled()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError):  # не главный поток / Windows
            pass


def log_stderr(message: str) -> None:
    try:
        sys.stderr.write(message.rstrip("\n") + "\n")
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass


class Emitter:
    """Пишет события JSON lines в поток (настоящий stdout). Всё остальное — stderr."""

    def __init__(self, stream: IO[str] | None = None) -> None:
        self._stream = stream if stream is not None else sys.stdout
        self._last_pct = 0

    def emit(self, obj: dict[str, Any]) -> None:
        line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        try:
            self._stream.write(line + "\n")
            self._stream.flush()
        except (BrokenPipeError, OSError):
            pass

    def progress(self, stage: str, frac: float, message: str) -> None:
        if stage not in _STAGE_BASE:
            raise ValueError(f"unknown stage {stage!r}")
        frac = 0.0 if frac < 0 else 1.0 if frac > 1 else frac
        pct = int(round(_STAGE_BASE[stage] + _STAGE_SHARE[stage] * frac))
        pct = max(pct, self._last_pct)  # прогресс не идёт назад
        pct = min(pct, 100)
        self._last_pct = pct
        self.emit({"event": "progress", "stage": stage, "pct": pct, "message": message})

    def log(self, level: str, message: str) -> None:
        if level not in ("info", "warn"):
            level = "info"
        self.emit({"event": "log", "level": level, "message": message})

    def done(self, out: str) -> None:
        self.emit({"event": "done", "out": out})

    def error(self, message: str, stage: str | None = None) -> None:
        self.emit({"event": "error", "message": message, "stage": stage})


class NullEmitter(Emitter):
    """Для тестов и библиотечного использования: события никуда не пишутся."""

    def __init__(self) -> None:
        super().__init__(stream=None)
        self.events: list[dict[str, Any]] = []

    def emit(self, obj: dict[str, Any]) -> None:
        self.events.append(obj)


class StageTimer:
    """Контекст: пишет в stderr время стадии."""

    def __init__(self, stage: str) -> None:
        self.stage = stage
        self.t0 = 0.0
        self.elapsed = 0.0

    def __enter__(self) -> "StageTimer":
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc: object) -> None:
        self.elapsed = time.perf_counter() - self.t0
        log_stderr(f"[remarka] stage={self.stage} took {self.elapsed:.2f}s")


def fmt_mmss(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"
