"""Края: тишина, пустая и очень короткая дорожка — отчёт со всеми null/na и предупреждениями, без падения. ASR не нужен."""

import numpy as np
import soundfile as sf
from conftest import SR

from remarka_engine import report
from remarka_engine.analyze import AnalyzeOptions, run_analyze
from remarka_engine.protocol import NullEmitter


def _run(path, out, **kw):
    em = NullEmitter()
    doc = run_analyze(AnalyzeOptions(mic=str(path), out=str(out), asr_model="small", llm="none", **kw), em)
    return doc, em


def _assert_all_na(doc):
    for layer in ("layer1", "layer2"):
        for k, v in doc["metrics"][layer].items():
            if k == "crutch_top":
                assert v == []
                continue
            if k in ("my_speech_sec", "words_total"):
                continue
            assert v["value"] is None and v["status"] == "na", (layer, k, v)


def test_silence_track(tmp_path):
    p = tmp_path / "silence.wav"
    sf.write(str(p), np.zeros(SR * 20, dtype=np.int16), SR)
    doc, em = _run(p, tmp_path / "r.json", meeting_type="pitch")
    assert report.validate(doc) == []
    assert any("тишина" in w for w in doc["engine"]["warnings"])
    _assert_all_na(doc)
    assert doc["transcript"]["words"] == [] and doc["events"] == []
    assert doc["baseline"]["status"] == "calibrating"
    assert doc["meeting"]["type"] == "pitch" and doc["meeting"]["type_source"] == "user"
    stages = [e["stage"] for e in em.events if e["event"] == "progress"]
    assert stages[0] == "load" and stages[-1] == "write"
    pcts = [e["pct"] for e in em.events if e["event"] == "progress"]
    assert pcts == sorted(pcts) and pcts[-1] == 100


def test_empty_track(tmp_path):
    p = tmp_path / "empty.wav"
    sf.write(str(p), np.zeros(0, dtype=np.int16), SR)
    doc, _ = _run(p, tmp_path / "r.json")
    assert report.validate(doc) == []
    assert doc["meeting"]["duration_sec"] == 0
    _assert_all_na(doc)


def test_short_noisy_track(tmp_path):
    p = tmp_path / "short.wav"
    sf.write(str(p), (np.random.default_rng(1).standard_normal(SR * 3) * 0.05).astype(np.float32), SR)
    doc, _ = _run(p, tmp_path / "r.json")
    assert report.validate(doc) == []
    assert any("короткая" in w or "тишина" in w or "речи" in w.lower() for w in doc["engine"]["warnings"])


def test_stereo_44k_resampled(tmp_path):
    p = tmp_path / "stereo.wav"
    sf.write(str(p), np.zeros((44100 * 2, 2), dtype=np.int16), 44100)
    doc, _ = _run(p, tmp_path / "r.json")
    assert doc["tracks"]["mic"]["sample_rate"] == 16000 and abs(doc["tracks"]["mic"]["duration_sec"] - 2.0) < 0.01
    assert any("16 кГц" in w for w in doc["engine"]["warnings"])


def test_bad_baseline_is_ignored(tmp_path):
    p = tmp_path / "silence.wav"
    sf.write(str(p), np.zeros(SR * 12, dtype=np.int16), SR)
    b = tmp_path / "baseline.json"
    b.write_text('{"schema_version": 1}', encoding="utf-8")
    doc, _ = _run(p, tmp_path / "r.json", baseline=str(b), calibration_meetings=2)
    assert doc["baseline"]["status"] == "calibrating" and doc["baseline"]["meetings_used"] == 2
    assert any("baseline" in w for w in doc["engine"]["warnings"])


def test_sanitize_nan():
    out = report.sanitize({"a": float("nan"), "b": [np.float64(1.5), np.int64(2), np.bool_(True)], "c": (1, 2)})
    assert out == {"a": None, "b": [1.5, 2, True], "c": [1, 2]}
