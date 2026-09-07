"""Протокол stdout: только JSON lines; ошибки → event error + код 1."""

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from conftest import ROOT, SR

from remarka_engine import cli


def _run(*args: str):
    proc = subprocess.run([sys.executable, "-m", "remarka_engine", *args], cwd=str(ROOT), capture_output=True, text=True, timeout=300, env={**os.environ, "PYTHONUNBUFFERED": "1"})
    lines = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    return proc.returncode, lines, proc.stderr


def test_doctor_is_single_json_line():
    code, lines, _ = _run("doctor", "--asr-model", "small")
    assert code == 0 and len(lines) == 1
    d = lines[0]
    assert d["event"] == "doctor" and set(d) >= {"ok", "python", "engine_version", "asr_model_cached", "llm_backend_available", "messages"}


def test_analyze_silence_protocol(tmp_path: Path):
    p = tmp_path / "silence.wav"
    sf.write(str(p), np.zeros(SR * 15, dtype=np.int16), SR)
    out = tmp_path / "r.json"
    code, lines, _ = _run("analyze", "--mic", str(p), "--out", str(out), "--asr-model", "small", "--llm", "none")
    assert code == 0
    assert all("event" in ev for ev in lines)
    assert lines[-1]["event"] == "done" and Path(lines[-1]["out"]) == out.resolve()
    assert any(ev["event"] == "log" and ev["level"] == "warn" for ev in lines)
    assert json.loads(out.read_text(encoding="utf-8"))["schema_version"] == 1


def test_analyze_missing_file_is_error_event(tmp_path: Path):
    code, lines, _ = _run("analyze", "--mic", str(tmp_path / "nope.wav"), "--out", str(tmp_path / "r.json"), "--llm", "none")
    assert code == 1
    assert lines[-1]["event"] == "error" and lines[-1]["stage"] == "load"


def test_baseline_command(tmp_path: Path):
    reps = []
    for i in (1, 2, 3):
        r = tmp_path / f"r{i}.json"
        r.write_text(json.dumps({"meeting": {"id": str(i), "started_at": f"2026-09-0{i}T10:00:00+03:00", "type": "pitch"}, "metrics": {"layer1": {"wpm": {"value": 100 + i}}, "layer2": {}}}), encoding="utf-8")
        reps.append(str(r))
    out = tmp_path / "baseline.json"
    code, lines, _ = _run("baseline", "--reports", *reps, "--out", str(out))
    assert code == 0 and lines[-1]["event"] == "done"
    b = json.loads(out.read_text(encoding="utf-8"))
    assert b["meeting_ids"] == ["1", "2", "3"] and abs(b["stats"]["layer1.wpm"]["mean"] - 102) < 1e-6


def test_patterns_without_module_reports_error(tmp_path: Path, monkeypatch):
    try:
        import remarka_engine.patterns  # noqa: F401

        return  # модуль агента «meaning» уже есть — обёртка проверяется его тестами
    except ImportError:
        pass
    r = tmp_path / "r.json"
    r.write_text("{}", encoding="utf-8")
    code, lines, _ = _run("patterns", "--reports", str(r), "--out", str(tmp_path / "p.json"))
    assert code == 1 and lines[-1]["event"] == "error" and "patterns" in lines[-1]["message"]


def test_llm_available_none():
    assert cli.llm_available("none")[0] is True
