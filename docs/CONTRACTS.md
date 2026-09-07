# Ремарка — контракты между компонентами

Продуктовый план: `docs/plan.html` (читать целиком перед работой — там тон, метрики, экраны, риски).
Типы данных: `src/types/contracts.ts` — источник истины. JSON‑схемы сгенерированы из него:
`docs/report.schema.json`, `docs/baseline.schema.json`, `docs/patterns.schema.json`, `docs/prep.schema.json`.
Регенерация: `npm run schemas` (см. package.json).

Все JSON — snake_case. Время — секунды от начала записи (float). Даты — ISO‑8601 с таймзоной.

---

## 0. Карта владения (кто что пишет)

| Каталог | Владелец | Технология |
|---|---|---|
| `engine/` (кроме `meaning.py`, `summary.py`, `patterns.py`, `prepare.py`, `llm.py`, `prompts/`) | агент «engine» | Python 3.11, faster‑whisper, parselmouth, numpy, scipy |
| `engine/remarka_engine/{llm.py,meaning.py,summary.py,patterns.py,prepare.py}`, `engine/remarka_engine/prompts/`, `engine/tests/test_meaning*.py` | агент «meaning» | Python, anthropic SDK, `claude` CLI |
| `src-tauri/` | агент «rust» | Rust, Tauri 2, cpal, hound, rusqlite |
| `tap/` и бинарник `src-tauri/binaries/remarka-tap-*` | агент «tap» | Swift 6, CoreAudio Process Taps |
| `src/` (кроме `src/types/contracts.ts`) | агент «frontend» | React 19, TypeScript, Vite, CSS‑переменные |
| `docs/`, `src/types/contracts.ts`, `README.md` | оркестратор | — |

Никто не редактирует чужие каталоги. Нужна правка контракта — пиши в отчёте, что и почему.

---

## 1. Структура каталогов

```
remarka/
  package.json, vite.config.ts, index.html, tsconfig.json
  src/                         фронтенд
    main.tsx, App.tsx
    types/contracts.ts         ← общие типы (не трогать)
    lib/api.ts                 типизированные обёртки invoke/listen + mock‑режим в браузере
    styles/tokens.css          токены дизайна (см. §9)
    screens/…                  экраны (см. §8)
    mock/                      генератор и пример отчёта для разработки без Tauri
  src-tauri/                   оболочка
    Cargo.toml, tauri.conf.json, capabilities/default.json, Info.plist
    binaries/remarka-tap-aarch64-apple-darwin   ← сайдкар (собирает tap/build.sh)
    src/…                      см. §6
  tap/                         Swift‑хелпер захвата системного звука (macOS)
    Package.swift, Sources/remarka-tap/main.swift, build.sh
  engine/                      Python‑движок
    pyproject.toml, .venv/     (uv, Python 3.11)
    remarka_engine/…           см. §3
    tests/                     pytest; fixtures/me.wav, fixtures/other.wav (48 с, 16 кГц, синтетика)
  docs/                        контракты, план, схемы
```

## 2. Каталог данных и SQLite

Каталог данных: Tauri `app_data_dir()` → macOS `~/Library/Application Support/com.remarka.app/`, Windows `%APPDATA%\com.remarka.app\`.
Идентификатор приложения: `com.remarka.app`.

```
<data_dir>/
  remarka.sqlite
  settings.json                 (Settings из contracts.ts)
  baseline.json                 (Baseline)
  patterns.json                 (PatternsResult, кэш)
  meetings/<meeting_id>/
    mic.wav                     16 кГц моно int16
    system.wav                  (если писали системный звук)
    report.json                 (Report)
    engine.log                  stderr движка
```

`meeting_id` — UUID v4 в нижнем регистре.

SQLite (rusqlite, bundled), миграции в коде:

```sql
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  duration_sec REAL NOT NULL DEFAULT 0,
  meeting_type TEXT NOT NULL DEFAULT 'other',
  type_source TEXT NOT NULL DEFAULT 'default',
  title TEXT,
  status TEXT NOT NULL,                -- recording|recorded|analyzing|ready|error
  has_system_track INTEGER NOT NULL DEFAULT 0,
  training_task_id TEXT,
  score REAL,
  wpm REAL, filled_pauses_per_min REAL, talk_ratio REAL,   -- денормализовано из отчёта для карточек
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS meetings_started ON meetings(started_at DESC);
```

Отчёт целиком лежит в `report.json`; в БД только то, что нужно карточкам и прогрессу. При `get_progress` Rust читает `report.json` всех `ready`‑встреч (их немного) и строит серии.

## 3. Движок: CLI и протокол

Пакет `engine/remarka_engine/`, запуск `python -m remarka_engine <cmd>` (и console‑script `remarka-engine`).

```
analyze   --mic PATH [--system PATH] --out REPORT.json
          [--meeting-id ID] [--started-at ISO] [--meeting-type TYPE] [--title T]
          [--training-task ID] [--baseline BASELINE.json]
          [--llm claude_cli|anthropic_api|none] [--llm-model claude-opus-5]
          [--asr-model large-v3-turbo] [--compute-type int8] [--language ru]
baseline  --reports R1.json R2.json R3.json --out baseline.json
patterns  --reports R1.json ... --out patterns.json [--llm ...] [--llm-model ...]
prepare   --topic "..." --type pitch --out prep.json [--llm ...] [--llm-model ...]
doctor    [--asr-model NAME] [--llm ...]        → JSON EngineDoctor‑подобный объект в stdout (одной строкой, event:"doctor")
download-model --asr-model NAME
```

Модули (ориентир, не догма):

```
remarka_engine/
  __init__.py  (__version__)
  __main__.py, cli.py
  audio.py         чтение WAV → float32 16 кГц, ресемплинг при необходимости, RMS/дБ
  vad.py           Silero через faster_whisper.vad.get_speech_timestamps (onnx, без torch)
  asr.py           faster-whisper, word_timestamps=True, initial_prompt для дословности (§3.3)
  fillers.py       детектор заполненных пауз (§4.2)
  segmenter.py     слова → предложения, паузы, нормализация текста
  metrics_l1.py    слой 1
  prosody.py       слой 2 (parselmouth)
  timeline.py      скользящие окна
  scoring.py       оценка 0–100 (§4.6)
  calibration.py   baseline
  report.py        сборка Report, валидация по docs/report.schema.json (jsonschema)
  llm.py           бэкенды: anthropic_api | claude_cli | none            ← агент «meaning»
  meaning.py       слой смысла (§5)                                       ← агент «meaning»
  summary.py       конспект + договорённости                              ← агент «meaning»
  patterns.py      межвстречные инсайты, недельная сводка, упражнения      ← агент «meaning»
  prepare.py       подготовка к встрече                                   ← агент «meaning»
  prompts/*.md     промпты                                                ← агент «meaning»
  data/crutch_words.json, data/fillers.json, data/reference_ranges.json, data/training_tasks.json
```

### 3.1 stdout — только JSON lines (`EngineEvent` из contracts.ts)

```
{"event":"progress","stage":"asr","pct":42,"message":"Распознавание: 13:20 из 32:10"}
{"event":"log","level":"warn","message":"..."}
{"event":"done","out":"/…/report.json"}
{"event":"error","message":"…","stage":"asr"}
```

Стадии по порядку: `load → vad → asr → align → fillers → prosody → metrics → meaning → summary → write`.
`pct` — общий прогресс 0–100 (оценочные доли: load 2, vad 5, asr 55, align 3, fillers 5, prosody 10, metrics 5, meaning 10, summary 3, write 2).
Всё постороннее (логи библиотек, tqdm, предупреждения) — в stderr. Код выхода 0/1.
Прерывание: SIGTERM → корректно завершиться с `{"event":"error","message":"cancelled"}`.

### 3.2 Модели ASR

faster‑whisper, `compute_type` по умолчанию `int8` на CPU (M‑серия: `device="cpu"`; CUDA — `device="auto"`).
Модели: `large-v3-turbo` (default, репозиторий `deepdml/faster-whisper-large-v3-turbo-ct2`), `large-v3`, `medium`, `small`, `base`.
Кэш моделей — стандартный HF cache (`~/.cache/huggingface`). `download-model` качает заранее, `doctor` сообщает, есть ли модель в кэше.
Тесты на fixtures используют `small` (или `base`) — быстро; помечать медленные тесты `@pytest.mark.slow`.

### 3.3 Дословность

Whisper выкидывает «э‑э»/«м‑м» (риск 01 плана). Меры:
1. `initial_prompt` на русском с примерами филлеров: «Э-э, ну, как бы, м-м, я думаю, что, э-э, это, типа, важно.» — подталкивает к дословной выдаче.
2. `condition_on_previous_text=False`, `vad_filter=False` (VAD делаем сами), `word_timestamps=True`, `beam_size=5`, `temperature=0`.
3. Собственный детектор заполненных пауз по сигналу (§4.2). Итоговое множество — объединение с дедупликацией по перекрытию.

## 4. Метрики — формулы

Все временные окна — по микрофонной дорожке; отрезки, где говорит собеседник (system_speech), из моих пауз исключаются.
Ориентиры по типам встреч — `engine/remarka_engine/data/reference_ranges.json` (§4.5). `MetricValue.status`:
`good` — внутри `[ref_low, ref_high]` (или в нужную сторону), `warn` — выход ≤ 20 % ширины ориентира (или ≤ 20 % от границы, если она одна), `bad` — дальше, `na` — value null.

### 4.1 Слой 1

- **Нормализация токена** `norm`: lower, ё→е, убрать всё кроме букв/цифр/дефиса внутри слова.
- **Заполненные паузы (filler)**: токен, чей `norm` матчится `^(э+|эм+|м+|мм+|а+|аа+|ээ+|хм+|гм+|ым+)$` (полный список в `data/fillers.json`), плюс детектор §4.2. `kind="filler"`, событие `filled_pause`.
- **Слова‑костыли (crutch)**: словарь `data/crutch_words.json` — униграммы и биграммы по `norm`. Базовый список: «как бы», «типа», «на самом деле», «вот», «собственно», «скажем так», «ну», «значит», «то есть», «в принципе», «короче», «просто», «это самое», «так сказать», «в общем», «по сути», «реально», «конкретно», «допустим», «как говорится», «в целом», «получается», «соответственно». Для «ну», «вот», «значит», «просто», «то есть», «получается», «соответственно» считать только если токен в начале предложения ИЛИ перед ним пауза ≥ 0,2 с ИЛИ после него пауза ≥ 0,2 с (иначе это нормальное употребление). `kind="crutch"` на первом слове биграммы, событие `crutch` с `label` = фраза.
- **Предложения**: по пунктуации ASR (`.`, `!`, `?`, `…`); если ASR не ставит пунктуацию — резать на паузах ≥ 0,8 с. `is_question` — заканчивается на `?`. Длина в словах без филлеров.
- **Паузы**: промежутки между концом слова i и началом слова i+1 (без филлеров — филлер не прерывает паузу, но и не является ей: считать паузы по «настоящим» словам, а филлер внутри паузы фиксируется как событие отдельно). Границы предложений и запятые/двоеточия/тире — «граница мысли».
  - `structural_pause`: gap ≥ 0,8 с И на границе мысли. Ориентир 3–6 в минуту, `better: inside`.
  - `hesitation_pause`: 0,3 ≤ gap < 0,8 с НЕ на границе мысли; либо gap ≥ 0,8 с не на границе (label «long»). Ориентир ≤ 4 в минуту.
  - Паузы, перекрывающиеся с `system_speech`, не считаются (собеседник говорил).
- **Темп (wpm)**: слова (без филлеров) / минуты **моей речи в окне** (время окна минус части, где говорит только собеседник и минус тишина > 2 с? — нет: темп речи считается по времени окна за вычетом отрезков, где говорит собеседник; так «тараторит» и «не делает пауз» различаются через артикуляционный темп). Общая метрика = медиана значений окон, где есть ≥ 5 слов.
- **Артикуляционный темп**: слова / (сумма длительностей речевых сегментов VAD в окне) — т. е. без пауз вовсе.
- **talk_ratio** = Σ mic_speech / (Σ mic_speech + Σ system_speech). null без системной дорожки.
- **Перебивания**: пересечение сегмента mic_speech и system_speech ≥ 0,5 с; кто начал позже — тот перебил, при условии что первый говорил уже ≥ 1,0 с. Событие `interruption_by_me` / `interruption_by_other`, `t` = начало пересечения.
- **MTLD**: McCarthy & Jarvis 2010, порог TTR 0,72, среднее forward/backward, по `norm` без филлеров. Если слов < 50 — null.
- **long_sentences_share**: доля предложений > 22 слов.
- **Скользящие окна** (`Timeline`): окно 15 с, шаг 5 с, t = центр окна; первая точка t=7.5 (окно 0–15), последняя — центр последнего полного окна. Точки без моей речи → `v: 0` для wpm, для pitch/loudness такие точки пропускаются.
- **fast_burst**: окно, где wpm > ref_high × 1.2 → событие на интервал окна.

### 4.2 Детектор заполненных пауз по сигналу

Кандидаты: сегменты VAD (mic) длительностью 0,25–2,0 с, которые не перекрываются ни с одним «настоящим» словом ASR более чем на 30 % своей длины. Проверки через parselmouth на вырезке сегмента:
- доля озвонченных кадров (f0 определён) ≥ 0,6;
- стандартное отклонение f0 в полутонах ≤ 1,5 (ровный тон, характерный для «э‑э»);
- средняя интенсивность ≥ (медианная интенсивность речи − 12 дБ).
Прошедшие → событие `filled_pause` с `source="detector"`, `label="э-э"` (или «м-м», если центроид спектра < 500 Гц). Дедуп с ASR‑филлерами: перекрытие ≥ 50 % → одно событие `source="both"`.

### 4.3 Слой 2 (только моя дорожка, только мои сегменты речи)

- f0: `sound.to_pitch_ac(time_step=0.01, pitch_floor=60, pitch_ceiling=400)`. Полутоны: `12·log2(f0/100)`.
- `pitch_median_hz`; `pitch_range_st` = P90 − P10 полутонов по озвонченным кадрам. Ориентир ≥ 4 пт (`better: higher`).
- `phrase_final_decay_db`: для каждого предложения — средняя интенсивность (дБ) на последних 0,5 с речи минус средняя интенсивность на средних 50 % предложения; берётся −(разница) = падение; метрика — медиана по предложениям длиннее 1,5 с. Ориентир ≤ 6 дБ (`better: lower`). Событие `decay` для предложений с падением > 6 дБ.
- `rising_statements_share`: среди `is_question=false` предложений длиннее 1 с — доля тех, где медиана f0 последних 0,4 с озвонченной речи выше медианы предыдущих 0,6 с на ≥ 2 пт. Ориентир ≤ 0,15. Событие `rising_statement` на такие предложения.
- `jitter_pct`, `shimmer_pct`: `praat.call([sound, point_process], "Get jitter (local)", …)` / `"Get shimmer (local)"` по конкатенации моих речевых сегментов (или среднее по сегментам, взвешенное длительностью). Ориентира нет (`better: lower`, status всегда `na` пока нет baseline; при baseline — по z).
- `start_jitter_ratio`: джиттер первых 120 с моей речи / джиттер остального (null если запись < 4 мин).
- `loudness_mean_db`, `loudness_drift_db` = mean(вторая половина) − mean(первая половина) интенсивности в дБ по моим сегментам. Ориентир ≥ −3 дБ (`better: higher`).
- Timeline `pitch_semitones`: медиана f0 окна в полутонах минус медиана говорящего; `loudness_db`: средняя интенсивность в окне.

### 4.4 События `question_from_other`

Если есть системная дорожка: её транскрипт режется на реплики (по паузам ≥ 1 с и пунктуации). Реплика с `?` (или начинающаяся с вопросительного слова: кто, что, как, почему, зачем, сколько, какой/какая/какие, где, когда, а что насчёт, скажите) → `is_question=true`, событие `question_from_other`.

### 4.5 Ориентиры по типам (`data/reference_ranges.json`)

| метрика | default | pitch | demo | sales | interview | standup | lecture | one_on_one | training |
|---|---|---|---|---|---|---|---|---|---|
| wpm | 100–130 | 110–140 | 110–140 | 100–130 | 100–130 | 110–150 | 90–120 | 100–130 | 100–130 |
| articulation_wpm | 130–170 | ← | ← | ← | ← | ← | 120–160 | ← | ← |
| filled_pauses_per_min | ≤ 3 | ≤ 2 | ≤ 3 | ≤ 3 | ≤ 2 | ≤ 4 | ≤ 2 | ≤ 4 | ≤ 1 |
| crutch_words_per_min | ≤ 2 | ← | ← | ← | ← | ≤ 3 | ← | ≤ 3 | ≤ 1 |
| structural_pauses_per_min | 3–6 | ← | ← | ← | ← | ← | 4–8 | ← | ← |
| hesitation_pauses_per_min | ≤ 4 | ← | ← | ← | ← | ← | ← | ← | ≤ 3 |
| talk_ratio | 0.4–0.7 | 0.70–0.80 | 0.60–0.75 | 0.40–0.45 | 0.50–0.70 | 0.10–0.40 | 0.85–1.0 | 0.40–0.60 | — |
| mean_sentence_len | ≤ 22 | ← | ← | ← | ← | ← | ← | ← | ← |
| long_sentences_share | ≤ 0.2 | ← | ← | ← | ← | ← | ← | ← | ← |
| mtld | ≥ 60 | ← | ← | ← | ← | — | ≥ 70 | ← | — |
| interruptions_by_me | ≤ 2 | ← | ← | ≤ 1 | ≤ 1 | ← | ← | ← | — |
| pitch_range_st | ≥ 4 | ← | ← | ← | ← | ← | ≥ 5 | ← | ← |
| phrase_final_decay_db | ≤ 6 | ← | ← | ← | ← | ← | ← | ← | ← |
| rising_statements_share | ≤ 0.15 | ← | ← | ← | ← | ← | ← | ← | ← |
| loudness_drift_db | ≥ −3 | ← | ← | ← | ← | ← | ← | ← | ← |

«←» = как default, «—» = не оценивается (status `na`, вес 0).

### 4.6 Оценка 0–100 (`Score`)

Веса (сумма 100): filled_pauses_per_min 20, wpm 15, pitch_range_st 15, crutch_words_per_min 10, hesitation_pauses_per_min 10, talk_ratio 10 (0 если null), phrase_final_decay_db 5, rising_statements_share 5, long_sentences_share 5, interruptions_by_me 5.
Штраф за метрику: 0 внутри ориентира; линейно до 1 при отклонении на 100 % ширины ориентира (для односторонних — на 100 % от граничного значения, минимум ширина 1). `overall = round(100 − Σ weight·penalty)`; если talk_ratio null — веса остальных масштабируются до 100.
При `baseline.status == "ready"`: `basis = "baseline"`, штраф считается как 0.5·(по ориентиру) + 0.5·clip(max(0, z_плохой_стороны)/2, 0, 1) — где z направлен в «плохую» сторону метрики.

### 4.7 Калибровка

`baseline` строится из первых 3 готовых встреч типа ≠ training: для каждой метрики ключи `layer1.wpm`, `layer1.articulation_wpm`, `layer1.filled_pauses_per_min`, `layer1.crutch_words_per_min`, `layer1.hesitation_pauses_per_min`, `layer1.structural_pauses_per_min`, `layer1.talk_ratio`, `layer1.mean_sentence_len`, `layer2.pitch_range_st`, `layer2.phrase_final_decay_db`, `layer2.rising_statements_share`, `layer2.jitter_pct`, `layer2.shimmer_pct`, `layer2.loudness_drift_db` → mean/std/n (std минимум 5 % от |mean| или 0.01). Rust вызывает `baseline` автоматически, когда ready‑встреч становится 3, и передаёт `--baseline` во все последующие анализы. В отчёте `BaselineComparison.status = "calibrating"` c `meetings_used` = число уже готовых встреч, пока базы нет.

## 5. Слой смысла (LLM)

Бэкенды (`llm.py`):
- `anthropic_api`: `anthropic.Anthropic()` (ключ из `ANTHROPIC_API_KEY`, который Rust пробрасывает из настроек в env процесса), `client.messages.parse(model=..., max_tokens=16000, messages=..., output_format=PydanticModel)` → `response.parsed_output`. Модель по умолчанию `claude-opus-5`, thinking адаптивный по умолчанию (параметр `thinking` не передавать). Стриминг не нужен.
- `claude_cli`: `claude -p --output-format json --model <model> "<prompt>"` через subprocess (stdin для промпта: `claude -p --output-format json` с промптом в stdin), ответ — JSON с полем `result` (строка); из неё извлекается JSON‑блок (первая `{` … последняя `}`) и валидируется той же Pydantic‑моделью; при ошибке парсинга — один повтор с добавлением «Ответь строго JSON по схеме: …». Таймаут 180 с. Если `claude` не найден в PATH — бэкенд недоступен.
- `none`: `meaning = null`, `summary` не строится.

Входы модели: тип встречи (если задан пользователем — фиксирован), транскрипт с таймкодами по предложениям `[mm:ss] текст`, реплики собеседника `[mm:ss] СОБЕСЕДНИК: …`, JSON посчитанных метрик со статусами и ориентирами, список событий (сжато: количество по видам + топ‑10 по времени). Модель НЕ измеряет, модель объясняет: промпт запрещает выдумывать числа.

Выход (`Meaning`): тип встречи с уверенностью, структура, вопросы собеседника с оценкой ответа, жаргон, `three_things` (ровно до 3), конспект, договорённости.
**Валидация цитат (риск 04 плана):** каждая `three_things[i].quote` ищется в транскрипте нечётко (`difflib.SequenceMatcher` по `norm`‑токенам, порог 0,8, окно = длина цитаты ± 3 слова). Не нашлась → рекомендация выбрасывается, `dropped_things += 1`. Нашлась → `t` = start первого слова совпадения. Если после валидации осталось < 3 — один повтор запроса с указанием «цитата должна быть дословной». `questions[].t` анкорится по тексту реплики собеседника, если она есть, иначе оставляется из ответа модели (округлённо по ближайшему предложению).

Патерны (`patterns`): вход — сжатые метрики N последних отчётов (id, дата, тип, метрики, timeline wpm первых 3 минут vs остального, score). Выход `PatternsResult`: инсайты вида «третий созвон подряд ты частишь в первые две минуты, дальше выравниваешься — это волнение на старте», недельная сводка, 2–4 упражнения под слабую сторону (со ссылкой на `training_task_id` из `data/training_tasks.json`, если подходит).

Подготовка (`prepare`): тема + тип → чеклист (5–8 пунктов) и 3 вопроса, которые зададут (для питча — юнит‑экономика, для демо — сравнение с конкурентом, для интервью — дыра в резюме, и т. д.), с «как подготовиться».

Язык всего — русский. Тон — как в плане: конкретно, без «говорите увереннее».

## 6. Оболочка (Rust / Tauri 2)

Модули:
```
src-tauri/src/
  main.rs, lib.rs            Builder, плагины, setup: трей, окна, state, поллер приложений для звонков
  state.rs                   AppState (Mutex): db, recorder, jobs, settings
  paths.rs                   data_dir, meeting_dir(id)
  db.rs                      rusqlite + миграции (§2)
  settings.rs                загрузка/сохранение settings.json, дефолты
  models.rs                  serde‑типы = contracts.ts (MeetingCard, Settings, AppState, события…)
  audio/mod.rs               Recorder: старт/стоп, два писателя WAV, тики
  audio/mic.rs               cpal input → f32 → ресемплинг в 16 кГц моно (rubato или линейный) → hound WAV int16
  audio/level.rs             RMS → дБFS с окном 100 мс
  audio/tempo.rs             оценка темпа по слоговым ядрам (§6.3)
  capture/mod.rs             trait SystemCapture { start(path) ; stop() -> duration ; level() }
  capture/macos.rs           запуск сайдкара remarka-tap (§7), чтение JSON lines
  capture/windows.rs         cpal WASAPI loopback (default output device как input)
  engine.rs                  запуск python‑движка, парсинг JSON lines → события, очередь задач (по одной)
  commands.rs                #[tauri::command] (§6.1)
  tray.rs                    иконка, меню (§6.2)
  meeting_apps.rs            поллинг процессов (sysinfo) раз в 5 с: zoom.us / Zoom.exe, Microsoft Teams, Яндекс.Телемост; Meet — по заголовкам окон не ловим (пропускаем)
```

Поиск python движка: `settings.engine_python` → иначе в dev‑сборке `env!("CARGO_MANIFEST_DIR")/../engine/.venv/bin/python` (на Windows `Scripts/python.exe`) → иначе сайдкар `remarka-engine` рядом с бинарником (на будущее, PyInstaller) → `engine_ok=false`.
Запуск: `<python> -m remarka_engine analyze …` с `cwd = engine/`, `PYTHONUNBUFFERED=1`, `ANTHROPIC_API_KEY` из настроек (если задан). stderr → `meetings/<id>/engine.log`.

### 6.1 Команды (все `Result<T, String>`, JSON‑поля snake_case)

```
get_app_state() -> AppState
list_audio_devices() -> AudioDevice[]
start_recording(opts: StartRecordingOpts) -> { meeting_id }
stop_recording() -> { meeting_id }              // затем при auto_analyze — analyze_meeting
cancel_recording() -> ()                         // удалить встречу и файлы
list_meetings() -> MeetingCard[]                 // по started_at DESC
get_meeting(id) -> MeetingCard
get_report(id) -> Report                         // содержимое report.json как JSON
analyze_meeting(id, llm: bool | null) -> ()      // асинхронно; события analysis:*
delete_meeting(id) -> ()
update_meeting(id, title: string | null, meeting_type: MeetingType | null) -> MeetingCard
get_audio_path(id, track: "mic" | "system") -> string   // абсолютный путь; фронтенд делает convertFileSrc
get_progress() -> ProgressData
get_baseline() -> Baseline | null
get_settings() -> Settings
set_settings(patch: Partial<Settings>) -> Settings
engine_doctor() -> EngineDoctor
prepare_meeting(topic: string, meeting_type: MeetingType) -> PrepResult
get_patterns() -> PatternsResult | null
refresh_patterns() -> PatternsResult
list_training_tasks() -> TrainingTask[]          // из engine data/training_tasks.json (копия в Rust как include_str)
show_main_window() -> ()
set_overlay_visible(visible: bool) -> ()
import_audio(opts: ImportAudioOpts) -> { meeting_id }   // копирует WAV (любой формат → 16 кГц через движок? нет: принимает только WAV; конвертация — забота пользователя/ffmpeg)
open_data_dir() -> ()
```

События — `EVENTS` в contracts.ts, payload — `Ev*` типы. `recording:tick` — раз в 250 мс.

### 6.2 Окна и трей

- Окно `main`: 1180×780, min 960×640, title «Ремарка», `#/` (hash‑роутинг). Закрытие окна — скрыть, не выходить (приложение живёт в трее). На macOS — обычная активность в Dock при открытом окне.
- Окно `overlay`: label `overlay`, 280×72, `alwaysOnTop`, `decorations:false`, `transparent:true`, `skipTaskbar:true`, `resizable:false`, позиция — правый верхний угол основного монитора с отступом 16 px, url `index.html#/overlay`. Показывается на старте записи если `settings.show_overlay`, скрывается по стопу.
- Трей: иконка (template на macOS), tooltip «Ремарка», меню: «Начать запись» / «Остановить запись» (динамически), «Открыть Ремарку», разделитель, «Выйти». Клик левой кнопкой — показать main. При `meeting-app:changed` с app ≠ null и `ask_on_meeting_app` — main показывает баннер «Идёт звонок в Zoom — начать запись?», и трей меняет tooltip.
- `tauri.conf.json`: `app.security.assetProtocol.enable = true`, scope `["$APPDATA/**", "$APPLOCALDATA/**"]`, `csp: null`; `bundle.macOS.minimumSystemVersion = "14.4"`; `bundle.externalBin = ["binaries/remarka-tap"]`; `Info.plist` с `NSMicrophoneUsageDescription` и `NSAudioCaptureUsageDescription` (русский текст). Capabilities: `core:default`, `core:window:allow-*` (show/hide/set-position/set-always-on-top), `core:event:default`, `shell` не нужен (спавним из Rust через std::process).

### 6.3 Живая оценка темпа (без ASR)

По микрофону, каждые 250 мс на последних 10 с: полосовой фильтр 300–3000 Гц (biquad), огибающая (RMS в окнах 10 мс), сглаживание 50 мс, пик‑детект с минимальной дистанцией 100 мс и prominence ≥ 3 дБ над локальным минимумом, только там, где уровень выше порога тишины (медиана + 6 дБ). Пики = слоговые ядра. `syl_per_sec` → `wpm_estimate = syl_per_sec·60/2.7` (среднее число слогов в русском слове ≈ 2,7). Если речи < 2 с в окне — null.

## 7. Swift‑хелпер `remarka-tap` (macOS 14.4+)

```
remarka-tap --out FILE.wav [--rate 16000] [--exclude-pid PID ...] [--level-interval-ms 200]
```
- Core Audio Process Taps: `CATapDescription(monoGlobalTapButExcludeProcesses: [excluded pids])`, `AudioHardwareCreateProcessTap`, агрегатное устройство с тапом (`kAudioAggregateDeviceTapListKey`, `kAudioSubTapUIDKey`), `AudioDeviceCreateIOProcIDWithBlock`, старт. Формат тапа → конвертация в 16 кГц моно int16 (AVAudioConverter или ручной децимационный ресемплинг с фильтром), запись WAV (заголовок дописывается при стопе).
- stdout JSON lines: `{"event":"ready"}` когда запись пошла; `{"event":"level","db":-31.2}` каждые 200 мс; `{"event":"stopped","duration_sec":12.3,"path":"…"}`; `{"event":"error","message":"…"}` + exit 1 (в т. ч. если нет разрешения — TCC «Запись системного звука»).
- Стоп: SIGINT/SIGTERM или строка `stop` в stdin. Собственный pid исключается автоматически; Rust передаёт `--exclude-pid <pid Ремарки>` дополнительно.
- Сборка: `tap/build.sh` → `swiftc -O -target arm64-apple-macos14.4` (и `x86_64` если возможно, затем `lipo`) → `src-tauri/binaries/remarka-tap-aarch64-apple-darwin` (+ `-x86_64-apple-darwin`). Tauri‑сайдкар именуется `<name>-<target triple>`.
- Разрешение: без бандла TCC привязывается к родительскому процессу (Terminal / приложение). В README описать: при первом запуске macOS спросит «Ремарка хочет записывать системный звук».

## 8. Экраны фронтенда (hash‑роутинг)

| маршрут | экран | что есть |
|---|---|---|
| `#/` | Лента встреч | карточки (дата, длительность, тип, оценка, дельта с прошлой), кнопка «Записать», баннер «Идёт звонок в Zoom», статус калибровки («2 из 3 встреч»), пустое состояние |
| `#/meeting/:id` | Разбор | сверху крупные числа (KPI: темп, заполненные паузы, доля речи, диапазон тона, длительность+тип), таймлайн (SVG: линия wpm с заливкой, тики заполненных пауз, полоски «говорит собеседник», отметки вопросов), клик по таймлайну → seek аудио и скролл транскрипта; транскрипт с подсветкой филлеров/костылей/пауз и активным словом при воспроизведении; блок «Три вещи» (title, why, quote с таймкодом‑кнопкой, instead); просодия (диапазон тона, затухание, восходящие утверждения, график громкости); вопросы собеседника и ответы; конспект и договорённости; сравнение с базой (дельты); правая колонка/вкладки — все метрики таблицей со статусами; смена типа встречи |
| `#/progress` | Прогресс | графики метрик по встречам (SVG), серия дней, сравнение месяцев, статус калибровки, инсайты `PatternsResult` и упражнения, кнопка «Обновить» |
| `#/training` | Тренировка | список заданий, выбор, запись с таймером (без системного звука), после стопа — переход в разбор |
| `#/prepare` | Подготовка | поле темы + тип → чеклист и 3 вопроса |
| `#/settings` | Настройки | системный звук по умолчанию (с предупреждением, риск 03), модель ASR (+ «скачать»), LLM‑бэкенд и ключ, устройство ввода, оверлей, тема, «Проверить движок», «Открыть папку данных» |
| `#/overlay` | Оверлей записи | таймер, индикатор уровня, полоска темпа (wpm_estimate против ориентира 100–130), кнопка «Стоп». Фон полупрозрачный, шрифт мелкий, ничего лишнего |

Аудио: `<audio src={convertFileSrc(path)}>`; таймкоды в отчёте — секунды от начала записи = позиция в файле.
Mock‑режим: если `window.__TAURI_INTERNALS__` отсутствует (обычный браузер), `lib/api.ts` подменяет invoke/listen на `src/mock/` (несколько встреч, отчёт из генератора, имитация записи и прогресса анализа таймерами). Это нужно, чтобы фронтенд проверялся в браузере через `npm run dev`.

## 9. Дизайн

Токены — ровно из `docs/plan.html` (`:root` и dark‑варианты): `--ground --surface --surface-2 --ink --ink-2 --ink-3 --rule --rule-soft --signal --signal-ink --signal-wash --ok --warn --shadow`, шрифты `Unbounded` (заголовки, крупные числа), `Golos Text` (текст), `JetBrains Mono` (метки, числа, таймкоды). Шрифты — локально через `@fontsource/unbounded`, `@fontsource/golos-text`, `@fontsource/jetbrains-mono` (десктоп может быть офлайн). Тема — `prefers-color-scheme` + настройка (`data-theme` на `<html>`).
Характер: редакционный, плотный, без скруглений‑пилюль и теней «как в SaaS»: тонкие линии `1px var(--rule)`, акцент `--signal` дозированно (одна линия темпа, один тег), моно‑подписи в верхнем регистре с трекингом, крупные цифры Unbounded. Всё на русском. Никаких «говорите увереннее» — в UI каждая правка с таймкодом.

## 10. Тренировочные задания (`data/training_tasks.json`)

Минимум 8 заданий, например:
- `elevator_60`: «Расскажи о своём проекте за 60 секунд, ни одной заполненной паузы» (60 с, filled_pauses_per_min)
- `slow_120`: «Прочитай/расскажи что угодно 2 минуты в темпе 100–120 сл/мин» (120 с, wpm)
- `pauses_90`: «Объясни сложную вещь, делая паузу ≥ 1 с после каждой мысли» (90 с, structural_pauses_per_min)
- `pitch_range_60`: «Расскажи историю с выраженной интонацией, диапазон ≥ 6 пт» (60 с, pitch_range_st)
- `endings_60`: «Договаривай окончания: последнее слово фразы не тише середины» (60 с, phrase_final_decay_db)
- `no_crutch_90`: «Отвечай на вопрос “почему ваш продукт лучше” без слов‑костылей» (90 с, crutch_words_per_min)
- `statement_60`: «Десять утверждений с нисходящей интонацией» (60 с, rising_statements_share)
- `answer_45`: «Ответь на вопрос про юнит‑экономику за 45 секунд, не уходя в размер рынка» (45 с, null)

## 11. Definition of done (для каждого агента)

- engine: `uv run pytest` зелёный; `python -m remarka_engine analyze --mic tests/fixtures/me.wav --system tests/fixtures/other.wav --out /tmp/r.json --asr-model small --llm none` даёт валидный по схеме отчёт с ≥ 3 событиями `filled_pause` и ≥ 2 `crutch`, `talk_ratio` в (0,1), ненулевым `pitch_range_st`.
- meaning: unit‑тесты валидации цитат и парсинга ответов CLI/API (с подменой бэкенда); реальный прогон через `claude_cli` на отчёте от фикстур даёт `three_things` с найденными цитатами.
- rust: `cargo build` без ошибок и предупреждений‑ошибок; `cargo test` для tempo/level/db; `npm run tauri dev` поднимает окно, трей, запись микрофона пишет валидный WAV 16 кГц; анализ запускается и события приходят.
- tap: `tap/build.sh` собирает бинарник; запуск на 5 с при играющем звуке даёт WAV с ненулевым сигналом; JSON‑события корректны.
- frontend: `npm run build` без ошибок TypeScript; в браузере (`npm run dev`) все экраны работают в mock‑режиме, таймлайн кликабелен, тёмная тема корректна; mock‑отчёт валиден по `docs/report.schema.json` (`npm run check:mock`).
