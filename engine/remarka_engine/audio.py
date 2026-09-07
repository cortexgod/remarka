"""Чтение WAV → float32 моно 16 кГц, уровни, тишина."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

TARGET_SR = 16000
SILENCE_DBFS = -55.0  # ниже — считаем дорожку тишиной
SHORT_SEC = 10.0  # короче — «очень короткая запись»


@dataclass
class Track:
    path: str
    sample_rate: int
    samples: np.ndarray  # float32, моно, 16 кГц, [-1, 1]
    duration_sec: float
    peak_dbfs: float
    rms_dbfs: float
    original_sample_rate: int
    original_channels: int

    @property
    def is_silent(self) -> bool:
        return self.duration_sec <= 0 or self.rms_dbfs < SILENCE_DBFS

    @property
    def is_short(self) -> bool:
        return self.duration_sec < SHORT_SEC

    def slice(self, start: float, end: float) -> np.ndarray:
        a = max(0, int(round(start * self.sample_rate)))
        b = min(len(self.samples), int(round(end * self.sample_rate)))
        if b <= a:
            return np.zeros(0, dtype=np.float32)
        return self.samples[a:b]

    def info(self) -> dict:
        return {
            "path": str(Path(self.path).resolve()),
            "sample_rate": self.sample_rate,
            "duration_sec": round(self.duration_sec, 3),
        }


def dbfs(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    if rms <= 1e-9:
        return -120.0
    return 20.0 * math.log10(rms)


def peak_dbfs(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    p = float(np.max(np.abs(x)))
    if p <= 1e-9:
        return -120.0
    return 20.0 * math.log10(p)


def resample(x: np.ndarray, sr_from: int, sr_to: int) -> np.ndarray:
    if sr_from == sr_to:
        return x.astype(np.float32, copy=False)
    from scipy.signal import resample_poly

    g = math.gcd(sr_from, sr_to)
    y = resample_poly(x.astype(np.float64), sr_to // g, sr_from // g)
    return np.clip(y, -1.0, 1.0).astype(np.float32)


def load_track(path: str | Path) -> Track:
    """Читает WAV/FLAC/… любой частоты и каналов; отдаёт моно float32 16 кГц."""
    import soundfile as sf

    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Аудиофайл не найден: {p}")
    data, sr = sf.read(str(p), dtype="float32", always_2d=True)
    channels = int(data.shape[1]) if data.ndim == 2 else 1
    mono = data.mean(axis=1) if channels > 1 else data[:, 0]
    mono = np.nan_to_num(mono).astype(np.float32)
    samples = resample(mono, int(sr), TARGET_SR)
    duration = len(samples) / TARGET_SR
    return Track(
        path=str(p),
        sample_rate=TARGET_SR,
        samples=samples,
        duration_sec=duration,
        peak_dbfs=peak_dbfs(samples),
        rms_dbfs=dbfs(samples),
        original_sample_rate=int(sr),
        original_channels=channels,
    )


def write_wav(path: str | Path, samples: np.ndarray, sr: int = TARGET_SR) -> None:
    import soundfile as sf

    sf.write(str(path), np.clip(samples, -1, 1).astype(np.float32), sr, subtype="PCM_16")
