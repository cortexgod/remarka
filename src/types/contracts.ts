/**
 * Ремарка — общие контракты между движком (Python), оболочкой (Rust/Tauri) и интерфейсом (React).
 *
 * ЭТО ИСТОЧНИК ИСТИНЫ ДЛЯ ФОРМ ДАННЫХ. Все JSON‑поля — snake_case.
 * Rust зеркалит эти типы через serde (`#[serde(rename_all = "snake_case")]` для enum'ов, поля как есть),
 * Python — через dataclass'ы/dict'ы и валидацию по docs/report.schema.json (генерируется из этого файла).
 *
 * Время везде — секунды от начала записи (float), если не сказано иное. Даты — ISO‑8601 строки.
 */

// ---------------------------------------------------------------------------
// Общие
// ---------------------------------------------------------------------------

export type MeetingType =
  | "pitch" // питч инвестору
  | "demo" // демо клиенту
  | "sales" // продажи / переговоры
  | "interview" // собеседование (я — кандидат)
  | "standup" // стендап команды
  | "lecture" // лекция / доклад / вебинар
  | "one_on_one" // 1:1
  | "training" // тренировочный режим без Zoom
  | "other";

export type MeetingStatus =
  | "recording"
  | "recorded" // записано, анализ не запускался
  | "analyzing"
  | "ready"
  | "error";

export type LlmBackend = "claude_cli" | "anthropic_api" | "none";

export interface TimeSpan {
  start: number;
  end: number;
}

export interface TimePoint {
  t: number;
  v: number;
}

// ---------------------------------------------------------------------------
// Отчёт (выход движка: report.json)
// ---------------------------------------------------------------------------

export interface Report {
  schema_version: 1;
  meeting: ReportMeeting;
  tracks: ReportTracks;
  segments: ReportSegments;
  transcript: Transcript;
  events: SpeechEvent[];
  timeline: Timeline;
  metrics: Metrics;
  score: Score;
  baseline: BaselineComparison | null;
  meaning: Meaning | null;
  engine: EngineInfo;
}

export interface ReportMeeting {
  id: string;
  started_at: string; // ISO‑8601
  duration_sec: number;
  type: MeetingType;
  type_confidence: number; // 0..1
  type_source: "llm" | "user" | "default";
  title: string | null;
  has_system_track: boolean;
  language: string; // "ru"
  training_task_id: string | null;
}

export interface TrackInfo {
  path: string; // абсолютный путь к WAV 16 кГц моно
  sample_rate: number;
  duration_sec: number;
}

export interface ReportTracks {
  mic: TrackInfo;
  system: TrackInfo | null;
}

export interface ReportSegments {
  mic_speech: TimeSpan[]; // VAD по микрофону
  system_speech: TimeSpan[]; // VAD по системному звуку (пусто, если дорожки нет)
}

export type WordKind = "word" | "filler" | "crutch";

export interface Word {
  i: number; // индекс в массиве words
  start: number;
  end: number;
  text: string; // как выдал ASR, с пунктуацией
  norm: string; // нормализовано: нижний регистр, без пунктуации, ё→е
  prob: number; // уверенность ASR 0..1
  kind: WordKind;
  sentence_i: number; // индекс предложения
}

export interface Sentence {
  i: number;
  start: number;
  end: number;
  text: string;
  word_from: number; // индекс первого слова (включительно)
  word_to: number; // индекс последнего слова (включительно)
  n_words: number;
  is_question: boolean;
}

export interface OtherUtterance {
  start: number;
  end: number;
  text: string;
  is_question: boolean;
}

export interface Transcript {
  words: Word[];
  sentences: Sentence[];
  other: OtherUtterance[]; // реплики собеседников с системной дорожки (пусто, если дорожки нет)
}

export type SpeechEventKind =
  | "filled_pause" // «э‑э», «м‑м»
  | "crutch" // слово‑костыль
  | "hesitation_pause" // пауза 0,3–0,8 с внутри синтагмы (или длиннее — тогда label = "long")
  | "structural_pause" // пауза ≥ 0,8 с на границе мысли
  | "interruption_by_me"
  | "interruption_by_other"
  | "rising_statement" // утверждение с восходящим тоном
  | "decay" // затухание к концу фразы > 6 дБ
  | "fast_burst" // окно темпа > верхней границы ориентира на ≥ 20 %
  | "question_from_other"; // вопрос собеседника (системная дорожка)

export interface SpeechEvent {
  t: number; // начало
  end: number; // конец (для точечных событий = t)
  kind: SpeechEventKind;
  label: string; // человекочитаемая метка: «э‑э», «как бы», «1,2 с», «+3,4 пт»
  source: "asr" | "detector" | "both" | "signal" | "llm";
  word_i: number | null; // привязка к слову, если есть
  sentence_i: number | null;
  value: number | null; // числовое значение события (длительность паузы, дБ, полутоны)
}

export interface Timeline {
  window_sec: number; // 15
  step_sec: number; // 5
  wpm: TimePoint[]; // темп речи, слов/мин, скользящее окно
  articulation_wpm: TimePoint[]; // артикуляционный темп (без пауз)
  pitch_semitones: TimePoint[]; // медиана f0 в окне, полутоны относительно медианы говорящего
  loudness_db: TimePoint[]; // средняя интенсивность моей речи в окне, дБ
  other_speaking: TimeSpan[]; // когда говорит собеседник
}

export interface MetricValue {
  value: number | null; // null — метрика не посчитана (например, нет системной дорожки)
  unit: string; // «сл/мин», «в мин», «%», «пт», «дБ», «слов», «» и т. п.
  ref_low: number | null; // нижняя граница ориентира (включительно)
  ref_high: number | null; // верхняя граница ориентира (включительно)
  better: "inside" | "higher" | "lower"; // что считать хорошим относительно ориентира
  status: "good" | "warn" | "bad" | "na"; // по ориентиру для типа встречи
}

export interface CrutchCount {
  word: string;
  count: number;
}

export interface Layer1Metrics {
  wpm: MetricValue;
  articulation_wpm: MetricValue;
  filled_pauses_total: MetricValue;
  filled_pauses_per_min: MetricValue;
  crutch_words_total: MetricValue;
  crutch_words_per_min: MetricValue;
  crutch_top: CrutchCount[];
  structural_pauses_per_min: MetricValue;
  hesitation_pauses_per_min: MetricValue;
  talk_ratio: MetricValue; // 0..1, null без системной дорожки
  mean_sentence_len: MetricValue; // слов
  long_sentences_share: MetricValue; // доля предложений > 22 слов, 0..1
  mtld: MetricValue;
  interruptions_by_me: MetricValue;
  interruptions_by_other: MetricValue;
  my_speech_sec: MetricValue;
  other_speech_sec: MetricValue;
  words_total: MetricValue;
}

export interface Layer2Metrics {
  pitch_median_hz: MetricValue;
  pitch_range_st: MetricValue; // P90−P10 f0 в полутонах
  phrase_final_decay_db: MetricValue; // медианное затухание к концу фразы, дБ (положительное = падение)
  rising_statements_share: MetricValue; // 0..1
  jitter_pct: MetricValue;
  shimmer_pct: MetricValue;
  start_jitter_ratio: MetricValue; // джиттер первых 2 минут / остального
  loudness_drift_db: MetricValue; // вторая половина − первая половина
  loudness_mean_db: MetricValue;
}

export interface Metrics {
  layer1: Layer1Metrics;
  layer2: Layer2Metrics;
}

export interface ScoreComponent {
  metric: string; // ключ метрики, например "layer1.filled_pauses_per_min"
  weight: number;
  penalty: number; // 0..1 доля снятого веса
}

export interface Score {
  overall: number; // 0..100
  components: ScoreComponent[];
  basis: "reference" | "baseline"; // относительно ориентиров или личной базы
}

export interface BaselineDelta {
  metric: string; // ключ, например "layer1.wpm"
  baseline: number;
  value: number;
  delta: number; // value − baseline
  z: number | null; // (value − baseline) / std, null если std = 0
}

export interface BaselineComparison {
  status: "calibrating" | "ready";
  meetings_used: number; // сколько встреч в базе (3 для ready)
  meetings_needed: number; // 3
  deltas: BaselineDelta[];
}

/** Файл baseline.json */
export interface Baseline {
  schema_version: 1;
  created_at: string;
  meeting_ids: string[];
  stats: Record<string, { mean: number; std: number; n: number }>; // ключ — как в BaselineDelta.metric
}

export interface MeaningQuestion {
  t: number; // момент вопроса (по системной дорожке, либо по моей речи если её нет)
  asked: string; // формулировка вопроса
  answered: "on_topic" | "partial" | "off_topic" | "not_answered";
  comment: string; // что именно было отвечено / куда ушёл
}

export interface MeaningJargon {
  t: number;
  term: string;
  comment: string;
}

export interface ThreeThing {
  title: string; // коротко, до 60 символов
  why: string; // почему это важно, 1–2 предложения
  quote: string; // ДОСЛОВНАЯ цитата из транскрипта (проверяется движком)
  t: number; // таймкод цитаты (выставляет движок по совпадению)
  instead: string; // что конкретно стоило сказать вместо
  metric: string | null; // ключ метрики, к которой относится, например "layer1.filled_pauses_per_min"
}

export interface Agreement {
  text: string;
  owner: string | null; // «я» / имя / null
  due: string | null; // свободный текст
}

export interface Meaning {
  backend: LlmBackend;
  model: string;
  meeting_type: { type: MeetingType; confidence: number; reason: string };
  structure: { kept: boolean; comment: string };
  questions: MeaningQuestion[];
  jargon: MeaningJargon[];
  three_things: ThreeThing[]; // ровно до 3, только с найденными цитатами
  dropped_things: number; // сколько рекомендаций отброшено за отсутствие цитаты
  summary: string; // конспект встречи, markdown
  agreements: Agreement[];
}

export interface EngineInfo {
  version: string;
  asr_model: string;
  asr_backend: string; // "faster-whisper"
  processing_sec: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Межвстречный слой (patterns.json) и подготовка (prep.json)
// ---------------------------------------------------------------------------

export interface PatternInsight {
  title: string; // «Третий созвон подряд ты частишь в первые две минуты»
  detail: string;
  metric: string | null;
  meeting_ids: string[];
}

export interface Exercise {
  title: string;
  instruction: string; // что делать, конкретно
  duration_min: number;
  targets_metric: string | null;
  training_task_id: string | null; // если есть готовое задание в тренажёре
}

export interface PatternsResult {
  schema_version: 1;
  generated_at: string;
  meetings_used: string[];
  insights: PatternInsight[];
  weekly_summary: string; // markdown
  exercises: Exercise[];
  backend: LlmBackend;
}

export interface PrepResult {
  topic: string;
  meeting_type: MeetingType;
  checklist: string[];
  likely_questions: { question: string; why: string; how_to_prepare: string }[];
  backend: LlmBackend;
}

// ---------------------------------------------------------------------------
// Оболочка (Rust ↔ фронтенд)
// ---------------------------------------------------------------------------

export interface MeetingCard {
  id: string;
  started_at: string;
  duration_sec: number;
  meeting_type: MeetingType;
  type_source: "llm" | "user" | "default";
  title: string | null;
  status: MeetingStatus;
  score: number | null;
  prev_score: number | null; // оценка предыдущей готовой встречи (для дельты)
  has_system_track: boolean;
  training_task_id: string | null;
  error: string | null;
  wpm: number | null; // главные числа для карточки
  filled_pauses_per_min: number | null;
  talk_ratio: number | null;
}

export interface RecordingState {
  meeting_id: string;
  started_at: string;
  elapsed_sec: number;
  system_audio: boolean;
  level_db: number; // уровень микрофона, дБFS (−60…0)
  system_level_db: number | null;
  wpm_estimate: number | null; // грубая оценка темпа по слоговым ядрам
}

export interface AppState {
  recording: RecordingState | null;
  analyzing: string[]; // id встреч в обработке
  engine_ok: boolean;
  platform: "macos" | "windows" | "linux";
  system_audio_supported: boolean;
  meeting_app_running: string | null; // "zoom" | "meet" | "teams" | "telemost" | null
  data_dir: string;
}

export interface AudioDevice {
  id: string;
  name: string;
  is_default: boolean;
}

export interface Settings {
  system_audio_default: boolean; // по умолчанию false (риск 03)
  auto_analyze: boolean; // анализ сразу после стопа
  asr_model: string; // "large-v3-turbo" | "large-v3" | "medium" | "small" | "base"
  asr_compute_type: string; // "int8" | "int8_float16" | "float16" | "float32"
  llm_backend: LlmBackend;
  llm_model: string; // "claude-opus-5"
  anthropic_api_key: string | null;
  llm_cli_path: string | null; // путь к claude или к SSH-обёртке (scripts/claude-ssh); null = искать claude в PATH
  language: string; // "ru"
  input_device: string | null;
  engine_python: string | null; // путь к python движка; null = автоопределение
  show_overlay: boolean;
  ask_on_meeting_app: boolean; // предлагать запись при запуске Zoom
  theme: "system" | "light" | "dark";
}

export interface EngineDoctor {
  ok: boolean;
  python: string | null;
  engine_version: string | null;
  asr_model_cached: boolean;
  llm_backend_available: boolean;
  messages: string[];
}

export interface ProgressSeriesPoint {
  meeting_id: string;
  started_at: string;
  value: number;
  meeting_type: MeetingType;
}

export interface ProgressData {
  series: Record<string, ProgressSeriesPoint[]>; // ключ метрики → точки по времени
  score: ProgressSeriesPoint[];
  streak_days: number; // дней подряд с записью (учитывая только рабочие дни)
  meetings_total: number;
  this_month: Record<string, number | null>; // средние по ключам метрик
  prev_month: Record<string, number | null>;
  baseline: BaselineComparison | null; // статус калибровки
}

export interface TrainingTask {
  id: string;
  title: string;
  instruction: string; // «Расскажи о своём проекте за 60 секунд, ни одной заполненной паузы»
  duration_sec: number;
  targets_metric: string | null;
  meeting_type: MeetingType; // обычно "training"
}

export interface StartRecordingOpts {
  system_audio: boolean;
  title?: string | null;
  meeting_type?: MeetingType | null;
  training_task_id?: string | null;
  input_device?: string | null;
}

export interface ImportAudioOpts {
  mic_path: string;
  system_path?: string | null;
  started_at?: string | null;
  meeting_type?: MeetingType | null;
  title?: string | null;
}

// События (tauri `listen`)
export interface EvRecordingStarted {
  meeting_id: string;
  started_at: string;
  system_audio: boolean;
}
export interface EvRecordingTick {
  meeting_id: string;
  elapsed_sec: number;
  level_db: number;
  system_level_db: number | null;
  wpm_estimate: number | null;
}
export interface EvRecordingStopped {
  meeting_id: string;
  duration_sec: number;
}
export interface EvAnalysisProgress {
  meeting_id: string;
  stage: string;
  pct: number;
  message: string;
}
export interface EvAnalysisDone {
  meeting_id: string;
  score: number | null;
}
export interface EvAnalysisError {
  meeting_id: string;
  message: string;
}
export interface EvRecordingWarning {
  meeting_id: string;
  message: string; // микрофон отключился / системная дорожка оборвалась
}
export interface EvMeetingApp {
  app: string | null; // "zoom" | "meet" | "teams" | "telemost" | null (null = завершилось)
}

export const EVENTS = {
  recordingStarted: "recording:started",
  recordingTick: "recording:tick",
  recordingStopped: "recording:stopped",
  recordingWarning: "recording:warning",
  analysisProgress: "analysis:progress",
  analysisDone: "analysis:done",
  analysisError: "analysis:error",
  meetingApp: "meeting-app:changed",
  meetingsChanged: "meetings:changed",
  settingsChanged: "settings:changed",
} as const;

// ---------------------------------------------------------------------------
// Протокол движка (stdout, JSON lines)
// ---------------------------------------------------------------------------

export type EngineStage =
  | "load"
  | "vad"
  | "asr"
  | "align"
  | "fillers"
  | "prosody"
  | "metrics"
  | "meaning"
  | "summary"
  | "write";

export type EngineEvent =
  | { event: "progress"; stage: EngineStage; pct: number; message: string }
  | { event: "log"; level: "info" | "warn"; message: string }
  | { event: "done"; out: string }
  | { event: "error"; message: string; stage: EngineStage | null };
