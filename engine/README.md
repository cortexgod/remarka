# remarka-engine

Локальный движок «Ремарки»: VAD (Silero через faster-whisper), ASR (faster-whisper),
детектор заполненных пауз по сигналу, просодия (parselmouth), метрики слоёв 1–2,
оценка, калибровка и сборка `report.json`.

```
python -m remarka_engine analyze --mic mic.wav [--system system.wav] --out report.json \
    [--asr-model large-v3-turbo] [--compute-type int8] [--llm none] [--meeting-type pitch] \
    [--baseline baseline.json] [--calibration-meetings N]
python -m remarka_engine baseline --reports r1.json r2.json r3.json --out baseline.json
python -m remarka_engine patterns --reports r1.json ... --out patterns.json [--llm ...]
python -m remarka_engine prepare --topic "..." --type pitch --out prep.json [--llm ...]
python -m remarka_engine doctor [--asr-model NAME] [--llm claude_cli]
python -m remarka_engine download-model --asr-model small
```

stdout — только JSON lines (`EngineEvent` из `src/types/contracts.ts`), всё остальное в stderr
(в т. ч. `[remarka] stage=… took …s` — тайминги стадий). SIGTERM → `{"event":"error","message":"cancelled"}`.
Контракты и формулы — `docs/CONTRACTS.md`.

## Модули

| Файл | Что делает |
|---|---|
| `protocol.py` | эмиттер событий, доли стадий, отмена по сигналу, тайминги |
| `audio.py` | WAV → float32 моно 16 кГц, уровни, тишина/короткая запись |
| `vad.py`, `spans.py` | Silero VAD (`faster_whisper.vad`), операции над отрезками |
| `asr.py` | faster-whisper, `word_timestamps`, `initial_prompt` для дословности, склейка токенов («Э»+«-э,»), фильтр галлюцинаций (вне VAD, «Редактор субтитров…») |
| `segmenter.py` | нормализация, предложения, паузы (структурные/хезитационные), реплики собеседника и вопросы |
| `fillers.py` | филлеры по ASR (`data/fillers.json`) и детектор по сигналу (§4.2), дедупликация |
| `crutches.py` | слова-костыли (`data/crutch_words.json`, n-граммы до 3, условные слова) |
| `prosody.py` | f0/интенсивность (parselmouth), диапазон тона, затухание фраз, восходящие утверждения, джиттер/шиммер |
| `timeline.py` | окна 15/5 с: wpm, артикуляционный темп, тон, громкость, fast_burst |
| `metrics_l1.py`, `references.py` | слой 1, ориентиры по типам, статусы |
| `scoring.py`, `calibration.py` | оценка 0–100, baseline |
| `report.py`, `analyze.py`, `cli.py` | сборка/валидация отчёта (jsonschema по `docs/report.schema.json`), конвейер, CLI |

Модули агента «meaning» (`llm.py`, `meaning.py`, `summary.py`, `patterns.py`, `prepare.py`, `prompts/`)
импортируются лениво. Ожидаемый интерфейс (лишние kwargs отбрасываются по сигнатуре):

- `llm.LlmClient(backend, model)`;
- `meaning.analyze_meaning(report, client, user_meeting_type, progress) -> dict | None`
  (`progress(pct, message)`: 0–75 — meaning, 75–100 — summary);
- `summary.summarize(report, client) -> {"summary", "agreements"}` — вызывается, только если
  `analyze_meaning` не вернул эти поля;
- `patterns.analyze_patterns(reports, client, training_tasks) -> PatternsResult`;
- `prepare.<prepare_meeting|build_prep|prepare|run>(topic, meeting_type, client) -> PrepResult`.

Если модуля нет или он упал — отчёт собирается как при `--llm none`, причина попадает в `engine.warnings`.

## Тесты и фикстуры

`uv run pytest` — весь набор (юнит-тесты без ASR + интеграция на фикстурах с моделью `small`, помечена `slow`).
`uv run pytest -m "not slow"` — только быстрые.
Фикстуры `tests/fixtures/{me,other}.wav` пересоздаются `tests/make_fixtures.sh [outdir]` (macOS `say -v Milena` + ffmpeg).
