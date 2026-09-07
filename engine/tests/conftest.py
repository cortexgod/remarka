from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from remarka_engine import segmenter  # noqa: E402
from remarka_engine.model import RawWord, Word  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SR = 16000


def raw_words(spec: list[tuple[str, float, float]], prob: float = 0.95) -> list[RawWord]:
    return [RawWord(start=s, end=e, text=t, prob=prob) for t, s, e in spec]


def words_from_text(text: str, start: float = 0.0, word_dur: float = 0.3, gap: float = 0.1, gaps: dict[int, float] | None = None) -> list[Word]:
    """Синтетические слова из текста: слово i начинается после gap (или gaps[i]) от конца предыдущего."""
    spec: list[tuple[str, float, float]] = []
    t = start
    for i, tok in enumerate(text.split()):
        if i > 0:
            t += (gaps or {}).get(i, gap)
        spec.append((tok, t, t + word_dur))
        t += word_dur
    words = segmenter.build_words(raw_words(spec))
    segmenter.split_sentences(words)
    return words


@pytest.fixture
def scratch(tmp_path: Path) -> Path:
    return tmp_path


@pytest.fixture
def silence_wav(tmp_path: Path) -> Path:
    import soundfile as sf

    p = tmp_path / "silence.wav"
    sf.write(str(p), np.zeros(SR * 20, dtype=np.int16), SR)
    return p


def fixtures_present() -> bool:
    return (FIXTURES / "me.wav").exists() and (FIXTURES / "other.wav").exists()


def running_slow() -> bool:
    return os.environ.get("REMARKA_RUN_SLOW", "") == "1"
