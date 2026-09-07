"""CLI движка (§3): analyze / baseline / patterns / prepare / doctor / download-model.

stdout — только JSON lines. Всё остальное (логи библиотек, tqdm, трейсбеки) — stderr.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import importlib
import os
import shutil
import sys
import traceback
from typing import Any

from . import __version__, asr
from .protocol import Cancelled, Emitter, install_cancel_handlers, log_stderr

LLM_BACKENDS = ["claude_cli", "anthropic_api", "none"]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="remarka-engine", description="Ремарка — движок анализа речи")
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_llm(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--llm", choices=LLM_BACKENDS, default="none")
        sp.add_argument("--llm-model", default="claude-opus-5")

    a = sub.add_parser("analyze", help="анализ записи → report.json")
    a.add_argument("--mic", required=True)
    a.add_argument("--system", default=None)
    a.add_argument("--out", required=True)
    a.add_argument("--meeting-id", default=None)
    a.add_argument("--started-at", default=None)
    a.add_argument("--meeting-type", default=None)
    a.add_argument("--title", default=None)
    a.add_argument("--training-task", default=None)
    a.add_argument("--baseline", default=None)
    add_llm(a)
    a.add_argument("--asr-model", default=asr.DEFAULT_MODEL)
    a.add_argument("--compute-type", default=asr.DEFAULT_COMPUTE_TYPE)
    a.add_argument("--language", default="ru")
    a.add_argument("--calibration-meetings", type=int, default=0, help="сколько готовых встреч уже есть (для status=calibrating)")
    a.add_argument("--no-validate", action="store_true", help="не проверять отчёт по схеме")

    b = sub.add_parser("baseline", help="baseline.json из отчётов")
    b.add_argument("--reports", nargs="+", required=True)
    b.add_argument("--out", required=True)

    rs = sub.add_parser("rescore", help="пересчёт готового отчёта под другой тип встречи (без ASR)")
    rs.add_argument("--report", required=True)
    rs.add_argument("--meeting-type", required=True)
    rs.add_argument("--baseline", default=None)
    rs.add_argument("--calibration-meetings", type=int, default=0)
    rs.add_argument("--type-source", default="user", choices=["user", "llm", "default"])
    rs.add_argument("--out", default=None, help="куда писать (по умолчанию — поверх --report)")

    pt = sub.add_parser("patterns", help="межвстречные инсайты (модуль patterns агента «meaning»)")
    pt.add_argument("--reports", nargs="+", required=True)
    pt.add_argument("--out", required=True)
    add_llm(pt)

    pr = sub.add_parser("prepare", help="подготовка к встрече (модуль prepare агента «meaning»)")
    pr.add_argument("--topic", required=True)
    pr.add_argument("--type", dest="meeting_type", default="other")
    pr.add_argument("--out", required=True)
    add_llm(pr)

    d = sub.add_parser("doctor", help="проверка окружения")
    d.add_argument("--asr-model", default=asr.DEFAULT_MODEL)
    d.add_argument("--llm", choices=LLM_BACKENDS, default="none")

    dl = sub.add_parser("download-model", help="скачать модель ASR в кэш")
    dl.add_argument("--asr-model", default=asr.DEFAULT_MODEL)
    return p


def llm_available(backend: str) -> tuple[bool, str]:
    if backend == "none":
        return True, "LLM выключен"
    try:
        mod = importlib.import_module("remarka_engine.llm")
        fn = getattr(mod, "is_available", None)
        if callable(fn):
            res = fn(backend)
            ok, msg = (bool(res[0]), str(res[1]) if len(res) > 1 else "") if isinstance(res, tuple) else (bool(res), "")
            if ok and backend == "claude_cli":
                path = mod.find_cli() if callable(getattr(mod, "find_cli", None)) else shutil.which("claude")
                if path and _cli_logged_in(path) is False:
                    return False, "claude CLI найден, но не авторизован: выполните `claude login` в терминале"
            return ok, msg
        if backend == "claude_cli" and callable(getattr(mod, "find_cli", None)):
            path = mod.find_cli()
            if path is None:
                return False, "claude CLI не найден в PATH"
            logged = _cli_logged_in(path)
            if logged is False:
                return False, "claude CLI найден, но не авторизован: выполните `claude login` в терминале"
            return True, f"claude CLI: {path}" + ("" if logged else " (статус авторизации не проверен)")
        if backend == "anthropic_api" and callable(getattr(mod, "has_api_credentials", None)):
            ok = bool(mod.has_api_credentials())
            return ok, ("ключ Anthropic API задан" if ok else "нет ANTHROPIC_API_KEY")
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001
        return False, f"llm: {e}"
    if backend == "claude_cli":
        path = shutil.which("claude")
        if path is None:
            return False, "claude CLI не найден в PATH"
        if _cli_logged_in(path) is False:
            return False, "claude CLI найден, но не авторизован: выполните `claude login` в терминале"
        return True, f"claude CLI: {path}"
    if backend == "anthropic_api":
        has_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
        try:
            importlib.import_module("anthropic")
        except ImportError:
            return False, "пакет anthropic не установлен"
        return has_key, ("ключ ANTHROPIC_API_KEY задан" if has_key else "нет ANTHROPIC_API_KEY")
    return False, f"неизвестный бэкенд {backend}"


def cmd_doctor(args: argparse.Namespace, em: Emitter) -> int:
    messages: list[str] = []
    ok = True
    try:
        import faster_whisper  # noqa: F401
        import parselmouth  # noqa: F401

        messages.append(f"faster-whisper {faster_whisper.__version__}, parselmouth {parselmouth.__version__}")
    except Exception as e:  # noqa: BLE001
        ok = False
        messages.append(f"Не хватает зависимостей: {e}")
    cached = asr.is_model_cached(args.asr_model)
    messages.append(f"Модель {args.asr_model}: {'в кэше' if cached else 'не скачана'}")
    llm_ok, llm_msg = llm_available(args.llm)
    if llm_msg:
        messages.append(llm_msg)
    for mod in ("meaning", "summary", "patterns", "prepare", "llm"):
        try:
            importlib.import_module(f"remarka_engine.{mod}")
        except ImportError:
            messages.append(f"Модуль {mod} отсутствует (слой смысла недоступен)")
            break
    from .report import docs_dir

    if docs_dir() is None:
        messages.append("Схемы docs/*.schema.json не найдены — отчёты не будут валидироваться")
    em.emit(
        {
            "event": "doctor",
            "ok": ok,
            "python": sys.executable,
            "engine_version": __version__,
            "asr_model_cached": cached,
            "llm_backend_available": llm_ok,
            "messages": messages,
        }
    )
    return 0 if ok else 1


def cmd_download_model(args: argparse.Namespace, em: Emitter) -> int:
    em.progress("load", 0.0, f"Загрузка модели {args.asr_model}")
    if asr.is_model_cached(args.asr_model):
        em.log("info", f"Модель {args.asr_model} уже в кэше")
    path = asr.download_model(args.asr_model)
    em.progress("load", 1.0, "Модель загружена")
    em.done(str(path))
    return 0


def cmd_analyze(args: argparse.Namespace, em: Emitter) -> int:
    from .analyze import AnalysisError, AnalyzeOptions, run_analyze

    opts = AnalyzeOptions(
        mic=args.mic,
        out=args.out,
        system=args.system,
        meeting_id=args.meeting_id,
        started_at=args.started_at,
        meeting_type=args.meeting_type,
        title=args.title,
        training_task=args.training_task,
        baseline=args.baseline,
        llm=args.llm,
        llm_model=args.llm_model,
        asr_model=args.asr_model,
        compute_type=args.compute_type,
        language=args.language,
        calibration_meetings=args.calibration_meetings,
        validate=not args.no_validate,
    )
    try:
        run_analyze(opts, em)
    except AnalysisError as e:
        log_stderr(traceback.format_exc())
        em.error(str(e), e.stage)
        return 1
    em.done(str(os.path.abspath(args.out)))
    return 0


def cmd_baseline(args: argparse.Namespace, em: Emitter) -> int:
    from .calibration import build_baseline
    from .report import read_json, validate, write_json

    reports = []
    for path in args.reports:
        try:
            reports.append(read_json(path))
        except Exception as e:  # noqa: BLE001
            em.log("warn", f"Отчёт {path} не прочитан: {e}")
    if not reports:
        em.error("Нет ни одного читаемого отчёта для базы", "metrics")
        return 1
    doc = build_baseline(reports)
    if not doc.get("stats"):
        em.error("Недостаточно данных для базы: ни одной метрики со значениями", "metrics")
        return 1
    errs = validate(doc, "baseline")
    if errs:
        em.error("baseline не по схеме: " + errs[0], "write")
        return 1
    out = write_json(doc, args.out)
    em.done(out)
    return 0


def cmd_rescore(args: argparse.Namespace, em: Emitter) -> int:
    from .report import read_json, sanitize, validate, write_json
    from .rescore import rescore

    em.progress("metrics", 0.0, "Пересчёт под тип встречи")
    try:
        doc = read_json(args.report)
    except Exception as e:  # noqa: BLE001
        em.error(f"Отчёт не прочитан: {e}", "load")
        return 1
    baseline_doc = None
    if args.baseline:
        try:
            baseline_doc = read_json(args.baseline)
            if validate(baseline_doc, "baseline"):
                baseline_doc = None
        except Exception as e:  # noqa: BLE001
            em.log("warn", f"baseline не прочитан: {e}")
    try:
        doc = sanitize(rescore(doc, args.meeting_type, baseline_doc=baseline_doc, calibration_meetings=args.calibration_meetings, type_source=args.type_source))
    except Exception as e:  # noqa: BLE001
        em.error(f"Пересчёт не удался: {e}", "metrics")
        return 1
    errs = validate(doc, "report")
    if errs:
        em.error("Отчёт после пересчёта не по схеме: " + errs[0], "write")
        return 1
    out = write_json(doc, args.out or args.report)
    em.progress("write", 1.0, f"Оценка: {doc['score']['overall']}")
    em.done(out)
    return 0


def _cli_logged_in(path: str) -> bool | None:
    """True/False по `claude auth status`, None — не удалось проверить."""
    try:
        proc = subprocess.run([path, "auth", "status"], capture_output=True, text=True, timeout=8)
        data = json.loads(proc.stdout or "{}")
        if isinstance(data, dict) and "loggedIn" in data:
            return bool(data["loggedIn"])
    except Exception:  # noqa: BLE001
        return None
    return None


def _meaning_module(name: str, em: Emitter) -> Any | None:
    try:
        return importlib.import_module(f"remarka_engine.{name}")
    except ImportError as e:
        em.error(f"Модуль {name} недоступен (слой смысла ещё не установлен): {e}", "meaning")
        return None


def cmd_patterns(args: argparse.Namespace, em: Emitter) -> int:
    from .analyze import _call_first
    from .report import read_json, sanitize, validate, write_json

    mod = _meaning_module("patterns", em)
    if mod is None:
        return 1
    reports = [read_json(p) for p in args.reports]
    em.progress("meaning", 0.0, "Поиск паттернов по встречам")
    try:
        from .analyze import make_llm_client
        from .references import load_training_tasks

        res = _call_first(
            mod,
            ["analyze_patterns", "build_patterns", "run_patterns", "run"],
            reports=reports,
            client=make_llm_client(args.llm, args.llm_model),
            training_tasks=load_training_tasks(),
            backend=args.llm,
            model=args.llm_model,
            log=em.log,
        )
    except Exception as e:  # noqa: BLE001
        log_stderr(traceback.format_exc())
        em.error(f"patterns: {e}", "meaning")
        return 1
    doc = sanitize(res)
    errs = validate(doc, "patterns")
    if errs:
        em.error("patterns.json не по схеме: " + errs[0], "write")
        return 1
    em.done(write_json(doc, args.out))
    return 0


def cmd_prepare(args: argparse.Namespace, em: Emitter) -> int:
    from .analyze import _call_first
    from .report import sanitize, validate, write_json

    mod = _meaning_module("prepare", em)
    if mod is None:
        return 1
    em.progress("meaning", 0.0, "Подготовка к встрече")
    try:
        from .analyze import make_llm_client

        res = _call_first(
            mod,
            ["prepare_meeting", "build_prep", "analyze_prepare", "prepare", "run_prepare", "run"],
            topic=args.topic,
            meeting_type=args.meeting_type,
            client=make_llm_client(args.llm, args.llm_model),
            backend=args.llm,
            model=args.llm_model,
            log=em.log,
        )
    except Exception as e:  # noqa: BLE001
        log_stderr(traceback.format_exc())
        em.error(f"prepare: {e}", "meaning")
        return 1
    doc = sanitize(res)
    errs = validate(doc, "prep")
    if errs:
        em.error("prep.json не по схеме: " + errs[0], "write")
        return 1
    em.done(write_json(doc, args.out))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    # Настоящий stdout — только для протокола; всё, что печатают библиотеки, уходит в stderr.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    em = Emitter(real_stdout)
    install_cancel_handlers()
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "0")
    handlers = {
        "analyze": cmd_analyze,
        "baseline": cmd_baseline,
        "rescore": cmd_rescore,
        "patterns": cmd_patterns,
        "prepare": cmd_prepare,
        "doctor": cmd_doctor,
        "download-model": cmd_download_model,
    }
    try:
        return handlers[args.cmd](args, em)
    except Cancelled:
        em.error("cancelled", None)
        return 1
    except SystemExit as e:
        return int(e.code or 0)
    except Exception as e:  # noqa: BLE001
        log_stderr(traceback.format_exc())
        em.error(f"{e.__class__.__name__}: {e}", None)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
