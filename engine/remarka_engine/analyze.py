"""Конвейер analyze: load → vad → asr → align → fillers → prosody → metrics → meaning → summary → write."""

from __future__ import annotations

import importlib
import time
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import __version__, asr, audio, calibration, crutches, fillers, metrics_l1, prosody, report, scoring, segmenter, timeline, vad
from .model import MetricValue, SpeechEvent, Transcript
from .protocol import Emitter, NullEmitter, StageTimer, fmt_mmss, log_stderr
from .references import MEETING_TYPES, metric_value, reference_for
from .spans import Span


@dataclass
class AnalyzeOptions:
    mic: str
    out: str
    system: str | None = None
    meeting_id: str | None = None
    started_at: str | None = None
    meeting_type: str | None = None
    title: str | None = None
    training_task: str | None = None
    baseline: str | None = None
    llm: str = "none"
    llm_model: str = "claude-opus-5"
    asr_model: str = asr.DEFAULT_MODEL
    compute_type: str = asr.DEFAULT_COMPUTE_TYPE
    language: str = "ru"
    calibration_meetings: int = 0
    validate: bool = True
    extra_warnings: list[str] = field(default_factory=list)


class AnalysisError(Exception):
    def __init__(self, message: str, stage: str) -> None:
        super().__init__(message)
        self.stage = stage


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _rewrap(metrics: dict[str, dict[str, MetricValue]], meeting_type: str) -> dict[str, dict[str, MetricValue]]:
    return {layer: {name: metric_value(name, mv.value, meeting_type, mv.unit) for name, mv in vals.items()} for layer, vals in metrics.items()}


def _metrics_dict(metrics: dict[str, dict[str, MetricValue]], crutch_top: list[dict]) -> dict[str, Any]:
    l1 = {k: v.to_dict() for k, v in metrics["layer1"].items()}
    l1["crutch_top"] = crutch_top
    l2 = {k: v.to_dict() for k, v in metrics["layer2"].items()}
    return {"layer1": l1, "layer2": l2}


def make_llm_client(backend: str, model: str) -> Any:
    """LlmClient агента «meaning» (remarka_engine.llm); ImportError, если модуля нет."""
    llm = importlib.import_module("remarka_engine.llm")
    client_cls = getattr(llm, "LlmClient", None)
    if client_cls is None:
        return None
    if backend in ("auto", "remote") and callable(getattr(llm, "detect_backend", None)):
        backend = llm.detect_backend(backend)
    try:
        return client_cls(backend=backend, model=model)
    except TypeError:
        return client_cls(backend, model)


def _call_first(module: Any, names: list[str], /, **kwargs: Any) -> Any:
    """Вызвать первую найденную функцию модуля агента «meaning», передав только те kwargs,
    которые она принимает (report/backend/model/log/…); результат Pydantic → dict."""
    import inspect

    for n in names:
        fn = getattr(module, n, None)
        if not callable(fn):
            continue
        try:
            params = inspect.signature(fn).parameters
            accepts_any = any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())
            call_kwargs = kwargs if accepts_any else {k: v for k, v in kwargs.items() if k in params}
        except (TypeError, ValueError):
            call_kwargs = kwargs
        res = fn(**call_kwargs)
        if hasattr(res, "model_dump"):
            res = res.model_dump(mode="json")
        return res
    raise AttributeError(f"в модуле {module.__name__} нет функций {names}")


def run_analyze(opts: AnalyzeOptions, emitter: Emitter | None = None) -> dict[str, Any]:
    em = emitter or NullEmitter()
    t_start = time.perf_counter()
    warnings: list[str] = list(opts.extra_warnings)
    stage = "load"

    def warn(msg: str) -> None:
        warnings.append(msg)
        em.log("warn", msg)

    meeting_type = opts.meeting_type if opts.meeting_type in MEETING_TYPES else None
    if opts.meeting_type and meeting_type is None:
        warn(f"Неизвестный тип встречи «{opts.meeting_type}», используется «other»")
    type_source = "user" if meeting_type else "default"
    type_conf = 1.0 if meeting_type else 0.0
    meeting_type = meeting_type or "other"

    # ---------------- load
    with StageTimer(stage):
        em.progress(stage, 0.0, "Чтение аудио")
        try:
            mic = audio.load_track(opts.mic)
        except Exception as e:  # noqa: BLE001
            raise AnalysisError(f"Не удалось прочитать микрофонную дорожку: {e}", stage) from e
        system = None
        if opts.system:
            try:
                system = audio.load_track(opts.system)
            except Exception as e:  # noqa: BLE001
                warn(f"Не удалось прочитать системную дорожку, анализ без неё: {e}")
                system = None
        if mic.original_sample_rate != audio.TARGET_SR or mic.original_channels != 1:
            warn(f"Микрофонная дорожка {mic.original_sample_rate} Гц / {mic.original_channels} кан. приведена к 16 кГц моно")
        if mic.duration_sec <= 0:
            warn("Микрофонная дорожка пустая: метрики не посчитаны")
        elif mic.is_silent:
            warn(f"Микрофонная дорожка — тишина ({mic.rms_dbfs:.0f} дБFS): метрики не посчитаны")
        elif mic.is_short:
            warn(f"Очень короткая запись ({mic.duration_sec:.1f} с): метрики ненадёжны")
        if system is not None and system.is_silent:
            warn("Системная дорожка — тишина: доля речи и перебивания посчитаны по пустой дорожке")
        duration = max(mic.duration_sec, system.duration_sec if system else 0.0)
        em.progress(stage, 1.0, f"Аудио прочитано: {fmt_mmss(duration)}")

    # ---------------- vad
    stage = "vad"
    with StageTimer(stage):
        em.progress(stage, 0.0, "Поиск речи (VAD)")
        try:
            mic_speech = vad.speech_spans(mic.samples, mic.sample_rate) if not mic.is_silent else []
            system_speech = vad.speech_spans(system.samples, system.sample_rate) if (system is not None and not system.is_silent) else []
        except Exception as e:  # noqa: BLE001
            raise AnalysisError(f"VAD не отработал: {e}", stage) from e
        if mic.duration_sec > 0 and not mic.is_silent and not mic_speech:
            warn("VAD не нашёл речи на микрофонной дорожке")
        em.progress(stage, 1.0, f"Речь: {fmt_mmss(sum(s.duration for s in mic_speech))} моей, {fmt_mmss(sum(s.duration for s in system_speech))} собеседника")

    # ---------------- asr
    stage = "asr"
    mic_raw: list = []
    sys_raw: list = []
    with StageTimer(stage):
        need_mic = bool(mic_speech)
        need_sys = bool(system_speech)
        if not need_mic and not need_sys:
            warn("Речи нет — распознавание пропущено")
            em.progress(stage, 1.0, "Распознавание пропущено: речи нет")
        else:
            em.progress(stage, 0.0, f"Загрузка модели {opts.asr_model}")
            if not asr.is_model_cached(opts.asr_model):
                em.log("info", f"Модель {opts.asr_model} не в кэше — загрузка из Hugging Face (может занять несколько минут)")
            t_model = time.perf_counter()
            try:
                model = asr.load_model(opts.asr_model, opts.compute_type)
            except Exception as e:  # noqa: BLE001
                raise AnalysisError(f"Не удалось загрузить модель ASR «{opts.asr_model}»: {e}", stage) from e
            log_stderr(f"[remarka] model {opts.asr_model}/{opts.compute_type} loaded in {time.perf_counter() - t_model:.2f}s")
            mic_dur = mic.duration_sec if need_mic else 0.0
            sys_dur = system.duration_sec if (need_sys and system is not None) else 0.0
            total_dur = max(mic_dur + sys_dur, 1e-6)

            def mic_progress(t: float) -> None:
                em.progress(stage, 0.02 + 0.98 * (min(t, mic_dur) / total_dur), f"Распознавание: {fmt_mmss(t)} из {fmt_mmss(mic_dur)}")

            def sys_progress(t: float) -> None:
                em.progress(stage, 0.02 + 0.98 * ((mic_dur + min(t, sys_dur)) / total_dur), f"Распознавание собеседника: {fmt_mmss(t)} из {fmt_mmss(sys_dur)}")

            try:
                if need_mic:
                    mic_raw, w = asr.transcribe(model, mic.samples, language=opts.language, initial_prompt=asr.INITIAL_PROMPT, speech_spans=mic_speech, on_progress=mic_progress)
                    warnings.extend(w)
                if need_sys and system is not None:
                    sys_raw, w = asr.transcribe(model, system.samples, language=opts.language, initial_prompt=None, speech_spans=system_speech, on_progress=sys_progress)
                    warnings.extend("Собеседник: " + x for x in w)
            except Exception as e:  # noqa: BLE001
                if e.__class__.__name__ == "Cancelled":
                    raise
                raise AnalysisError(f"Ошибка распознавания: {e}", stage) from e
            if need_mic and not mic_raw:
                warn("ASR не выдал ни одного слова на микрофонной дорожке")
            em.progress(stage, 1.0, f"Распознано слов: {len(mic_raw)}")

    # ---------------- align
    stage = "align"
    with StageTimer(stage):
        em.progress(stage, 0.0, "Разметка слов и предложений")
        words = segmenter.build_words(mic_raw)
        sentences = segmenter.split_sentences(words)
        other = segmenter.split_other_utterances(sys_raw)
        events: list[SpeechEvent] = []
        for o in other:
            if o.is_question:
                events.append(SpeechEvent(t=o.start, end=o.end, kind="question_from_other", label=o.text, source="asr", word_i=None, sentence_i=None, value=None))
        em.progress(stage, 1.0, f"Предложений: {len(sentences)}, реплик собеседника: {len(other)}")

    # ---------------- fillers
    stage = "fillers"
    with StageTimer(stage):
        em.progress(stage, 0.0, "Заполненные паузы и слова-костыли")
        asr_fillers = fillers.mark_asr_fillers(words)
        segmenter.refresh_sentence_counts(words, sentences)
        det: list[SpeechEvent] = []
        if mic_speech:
            try:
                ref_db = fillers.speech_intensity_median_db(mic.samples, mic.sample_rate, mic_speech)
                det = fillers.detect_filled_pauses(mic.samples, mic.sample_rate, mic_speech, words, ref_db)
            except Exception as e:  # noqa: BLE001
                warn(f"Детектор заполненных пауз не отработал: {e}")
        filler_events = fillers.merge_filler_events(asr_fillers, det)
        crutch_events = crutches.detect_crutches(words, sentences)
        events += filler_events + crutch_events
        em.progress(stage, 1.0, f"Заполненных пауз: {len(filler_events)}, костылей: {len(crutch_events)}")

    # ---------------- prosody
    stage = "prosody"
    with StageTimer(stage):
        em.progress(stage, 0.0, "Просодия: тон и громкость")
        try:
            pros = prosody.analyze(mic.samples, mic.sample_rate, mic_speech, sentences, duration)
        except Exception as e:  # noqa: BLE001
            warn(f"Просодия не посчитана: {e}")
            log_stderr(traceback.format_exc())
            pros = prosody.ProsodyResult({k: None for k in ("pitch_median_hz", "pitch_range_st", "phrase_final_decay_db", "rising_statements_share", "jitter_pct", "shimmer_pct", "start_jitter_ratio", "loudness_drift_db", "loudness_mean_db")}, [], prosody.ProsodyFrames())
        events += pros.events
        em.progress(stage, 1.0, "Просодия посчитана")

    # ---------------- metrics
    stage = "metrics"
    with StageTimer(stage):
        em.progress(stage, 0.0, "Метрики")
        pause_events = segmenter.find_pauses(words, system_speech)
        inter_events = metrics_l1.interruptions(mic_speech, system_speech) if system is not None else []
        events += pause_events + inter_events
        _, ref_high_wpm, _ = reference_for("wpm", meeting_type)
        tl = timeline.build(words, mic_speech, system_speech, duration, pros.frames, ref_high_wpm)
        events += tl.fast_bursts
        events.sort(key=lambda e: (e.t, e.end))
        l1_inputs = metrics_l1.Layer1Inputs(words=words, sentences=sentences, events=events, mic_speech=mic_speech, system_speech=system_speech, has_system=system is not None, duration_sec=duration, timeline=tl)
        l1, crutch_top = metrics_l1.compute(l1_inputs, meeting_type)
        l2 = {k: metric_value(k, v, meeting_type) for k, v in pros.values.items()}
        metrics: dict[str, dict[str, MetricValue]] = {"layer1": l1, "layer2": l2}
        baseline_doc = None
        if opts.baseline:
            try:
                baseline_doc = report.read_json(opts.baseline)
                errs = report.validate(baseline_doc, "baseline")
                if errs:
                    warn(f"baseline.json не по схеме, игнорируется: {errs[0]}")
                    baseline_doc = None
            except Exception as e:  # noqa: BLE001
                warn(f"Не удалось прочитать baseline: {e}")
        baseline_cmp = calibration.compare(metrics, baseline_doc) if baseline_doc else calibration.calibrating(opts.calibration_meetings)
        score = scoring.compute_score(metrics, baseline_doc["stats"] if baseline_doc else None)
        em.progress(stage, 1.0, f"Оценка: {score['overall']}")

    transcript = Transcript(words=words, sentences=sentences, other=other)
    meeting_id = opts.meeting_id or str(uuid.uuid4())
    started_at = opts.started_at or _now_iso()

    def assemble(meaning: dict[str, Any] | None) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "meeting": {
                "id": meeting_id,
                "started_at": started_at,
                "duration_sec": round(duration, 3),
                "type": meeting_type,
                "type_confidence": type_conf,
                "type_source": type_source,
                "title": opts.title,
                "has_system_track": system is not None,
                "language": opts.language,
                "training_task_id": opts.training_task,
            },
            "tracks": {"mic": mic.info(), "system": system.info() if system else None},
            "segments": {"mic_speech": [s.to_dict() for s in mic_speech], "system_speech": [s.to_dict() for s in system_speech]},
            "transcript": transcript.to_dict(),
            "events": [e.to_dict() for e in events],
            "timeline": tl.to_dict(),
            "metrics": _metrics_dict(metrics, crutch_top),
            "score": score,
            "baseline": baseline_cmp,
            "meaning": meaning,
            "engine": {
                "version": __version__,
                "asr_model": opts.asr_model,
                "asr_backend": "faster-whisper",
                "processing_sec": round(time.perf_counter() - t_start, 3),
                "warnings": list(warnings),
            },
        }

    # ---------------- meaning + summary (агент «meaning», ленивый импорт)
    stage = "meaning"
    meaning: dict[str, Any] | None = None
    with StageTimer(stage):
        if opts.llm == "none":
            em.progress(stage, 1.0, "Слой смысла выключен")
        elif not words:
            warn("Слой смысла пропущен: нет транскрипта")
            em.progress(stage, 1.0, "Слой смысла пропущен")
        else:
            em.progress(stage, 0.0, f"Слой смысла ({opts.llm})")
            draft = assemble(None)
            reached_summary = False

            def meaning_progress(pct: float, message: str = "") -> None:
                # у агента «meaning»: 0–75 — meaning, 75–100 — summary
                nonlocal reached_summary
                pct = float(pct or 0)
                if pct <= 75 and not reached_summary:
                    em.progress("meaning", pct / 75.0, message or "Слой смысла")
                else:
                    reached_summary = True
                    em.progress("summary", max(0.0, pct - 75.0) / 25.0, message or "Конспект")

            try:
                client = make_llm_client(opts.llm, opts.llm_model)
                mod = importlib.import_module("remarka_engine.meaning")
                meaning = _call_first(
                    mod,
                    ["analyze_meaning", "build_meaning", "run_meaning", "analyze", "run"],
                    report=draft,
                    client=client,
                    user_meeting_type=opts.meeting_type if type_source == "user" else None,
                    progress=meaning_progress,
                    backend=opts.llm,
                    model=opts.llm_model,
                    log=em.log,
                )
                if meaning is not None and not isinstance(meaning, dict):
                    raise TypeError(f"meaning вернул {type(meaning).__name__}, ожидался dict")
            except ImportError as e:
                warn(f"Слой смысла недоступен (модуль meaning/llm не установлен): {e}")
            except Exception as e:  # noqa: BLE001
                if e.__class__.__name__ == "Cancelled":
                    raise
                warn(f"Слой смысла не отработал, отчёт без него: {e}")
                log_stderr(traceback.format_exc())
            if not reached_summary:
                # стадии идут строго по порядку (§3.1): если модуль уже отчитался стадией summary,
                # обратно в meaning не возвращаемся
                em.progress(stage, 1.0, "Слой смысла готов" if meaning else "Слой смысла пропущен")
    stage = "summary"
    with StageTimer(stage):
        if meaning is not None and ("summary" not in meaning or "agreements" not in meaning):
            em.progress(stage, 0.0, "Конспект и договорённости")
            try:
                mod = importlib.import_module("remarka_engine.summary")
                res = _call_first(
                    mod,
                    ["summarize", "build_summary", "run_summary", "run"],
                    report=assemble(meaning),
                    client=make_llm_client(opts.llm, opts.llm_model),
                    backend=opts.llm,
                    model=opts.llm_model,
                    log=em.log,
                )
                if isinstance(res, dict):
                    meaning["summary"] = res.get("summary") or meaning.get("summary") or ""
                    meaning["agreements"] = res.get("agreements") or meaning.get("agreements") or []
            except Exception as e:  # noqa: BLE001
                if e.__class__.__name__ == "Cancelled":
                    raise
                warn(f"Конспект не построен: {e}")
            meaning.setdefault("summary", "")
            meaning.setdefault("agreements", [])
        em.progress(stage, 1.0, "Конспект готов" if meaning else "Конспект пропущен")

    if meaning is not None:
        mt = meaning.get("meeting_type") or {}
        if type_source != "user" and mt.get("type") in MEETING_TYPES:
            new_type = mt["type"]
            if new_type != meeting_type:
                meeting_type = new_type
                metrics = _rewrap(metrics, meeting_type)
                baseline_cmp = calibration.compare(metrics, baseline_doc) if baseline_doc else calibration.calibrating(opts.calibration_meetings)
                score = scoring.compute_score(metrics, baseline_doc["stats"] if baseline_doc else None)
                # fast_burst зависит от верхней границы темпа для типа встречи — пересчитать
                _, ref_high_wpm, _ = reference_for("wpm", meeting_type)
                events[:] = [e for e in events if e.kind != "fast_burst"]
                events += timeline.build(words, mic_speech, system_speech, duration, pros.frames, ref_high_wpm).fast_bursts
                events.sort(key=lambda e: (e.t, e.end))
            type_source = "llm"
            type_conf = float(mt.get("confidence", 0.0) or 0.0)

    # ---------------- write
    stage = "write"
    with StageTimer(stage):
        em.progress(stage, 0.0, "Запись отчёта")
        doc = report.sanitize(assemble(meaning))
        if opts.validate:
            if report.load_schema("report") is None:
                warn("Схема docs/report.schema.json не найдена — отчёт не проверен")
                doc["engine"]["warnings"] = list(warnings)
            else:
                errs = report.validate(doc, "report")
                if errs and meaning is not None and all(e.startswith("meaning") for e in errs):
                    warn("Слой смысла не по схеме, отброшен: " + errs[0])
                    doc["meaning"] = None
                    doc["engine"]["warnings"] = list(warnings)
                    errs = report.validate(doc, "report")
                if errs:
                    raise AnalysisError("Отчёт не прошёл валидацию по схеме: " + "; ".join(errs[:5]), stage)
        doc["engine"]["processing_sec"] = round(time.perf_counter() - t_start, 3)
        out = report.write_json(doc, opts.out)
        em.progress(stage, 1.0, "Готово")
        log_stderr(f"[remarka] total {doc['engine']['processing_sec']:.2f}s → {out}")
    return doc
