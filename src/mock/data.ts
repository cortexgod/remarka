/** Статические данные mock‑мира: встречи, задания, паттерны, подготовка, настройки. */
import type {
  AudioDevice,
  EngineDoctor,
  Exercise,
  MeetingType,
  PatternsResult,
  PrepResult,
  Settings,
  TrainingTask,
} from "../types/contracts.ts";

export const DATA_DIR = "/Users/me/Library/Application Support/com.remarka.app";

export const DEFAULT_SETTINGS: Settings = {
  system_audio_default: false,
  auto_analyze: true,
  asr_model: "large-v3-turbo",
  asr_compute_type: "int8",
  llm_backend: "claude_cli",
  llm_model: "claude-opus-5",
  anthropic_api_key: null,
  llm_cli_path: null,
  language: "ru",
  input_device: null,
  engine_python: null,
  show_overlay: true,
  ask_on_meeting_app: true,
  theme: "system",
};

export const AUDIO_DEVICES: AudioDevice[] = [
  { id: "builtin", name: "Микрофон MacBook Pro", is_default: true },
  { id: "airpods", name: "AirPods Pro", is_default: false },
  { id: "yeti", name: "Blue Yeti", is_default: false },
];

/** Задания тренажёра — §10 CONTRACTS.md */
export const TRAINING_TASKS: TrainingTask[] = [
  { id: "elevator_60", title: "Лифт за 60 секунд", instruction: "Расскажи о своём проекте за 60 секунд, ни одной заполненной паузы.", duration_sec: 60, targets_metric: "layer1.filled_pauses_per_min", meeting_type: "training" },
  { id: "slow_120", title: "Медленно и ровно", instruction: "Прочитай или расскажи что угодно 2 минуты в темпе 100–120 слов в минуту.", duration_sec: 120, targets_metric: "layer1.wpm", meeting_type: "training" },
  { id: "pauses_90", title: "Пауза после мысли", instruction: "Объясни сложную вещь, делая паузу не короче секунды после каждой мысли.", duration_sec: 90, targets_metric: "layer1.structural_pauses_per_min", meeting_type: "training" },
  { id: "pitch_range_60", title: "Интонация", instruction: "Расскажи историю с выраженной интонацией: диапазон тона не меньше 6 полутонов.", duration_sec: 60, targets_metric: "layer2.pitch_range_st", meeting_type: "training" },
  { id: "endings_60", title: "Договаривай окончания", instruction: "Последнее слово каждой фразы — не тише её середины.", duration_sec: 60, targets_metric: "layer2.phrase_final_decay_db", meeting_type: "training" },
  { id: "no_crutch_90", title: "Без костылей", instruction: "Ответь на вопрос «почему ваш продукт лучше» без слов‑костылей: «как бы», «типа», «на самом деле», «вот».", duration_sec: 90, targets_metric: "layer1.crutch_words_per_min", meeting_type: "training" },
  { id: "statement_60", title: "Утверждение — вниз", instruction: "Десять утверждений с нисходящей интонацией. Ни одно не должно звучать как вопрос.", duration_sec: 60, targets_metric: "layer2.rising_statements_share", meeting_type: "training" },
  { id: "answer_45", title: "Ответ на вопрос", instruction: "Ответь на вопрос про юнит‑экономику за 45 секунд, не уходя в размер рынка.", duration_sec: 45, targets_metric: null, meeting_type: "training" },
];

export interface MockMeetingSpec {
  id: string;
  seed: number;
  type: MeetingType;
  type_source: "llm" | "user" | "default";
  title: string | null;
  duration_sec: number;
  daysAgo: number;
  hour: number;
  minute: number;
  /** если задано — время относительно «сейчас» (для сегодняшних карточек) */
  minutesAgo?: number;
  status: "ready" | "analyzing" | "error" | "recorded";
  has_system_track: boolean;
  training_task_id?: string | null;
  error?: string | null;
  layer2?: Partial<Record<string, number | null>>;
  scenario?: "pitch" | "generic";
}

export const MAIN_MEETING_ID = "7c1e2a4b-5d6f-4a8b-9c0d-1e2f3a4b5c6d";

/** Порядок — от старой к новой. */
export const MEETING_SPECS: MockMeetingSpec[] = [
  { id: "a1b2c3d4-0001-4a00-8000-000000000001", seed: 101, type: "sales", type_source: "llm", title: "Созвон с «Ламода‑партнёр»", duration_sec: 1440, daysAgo: 19, hour: 11, minute: 0, status: "ready", has_system_track: true,
    layer2: { pitch_range_st: 4.6, phrase_final_decay_db: 5.1, rising_statements_share: 0.12, loudness_drift_db: -1.2 } },
  { id: "a1b2c3d4-0002-4a00-8000-000000000002", seed: 102, type: "one_on_one", type_source: "user", title: "1:1 с Леной", duration_sec: 1680, daysAgo: 15, hour: 16, minute: 30, status: "ready", has_system_track: true,
    layer2: { pitch_range_st: 4.9, phrase_final_decay_db: 4.4, rising_statements_share: 0.1, loudness_drift_db: -0.6 } },
  { id: "a1b2c3d4-0003-4a00-8000-000000000003", seed: 103, type: "demo", type_source: "llm", title: "Демо для сети обуви", duration_sec: 1080, daysAgo: 12, hour: 12, minute: 15, status: "ready", has_system_track: true,
    layer2: { pitch_range_st: 4.2, phrase_final_decay_db: 5.8, rising_statements_share: 0.14, loudness_drift_db: -2.1 } },
  { id: "a1b2c3d4-0004-4a00-8000-000000000004", seed: 104, type: "standup", type_source: "llm", title: null, duration_sec: 540, daysAgo: 8, hour: 10, minute: 5, status: "ready", has_system_track: false,
    layer2: { pitch_range_st: 3.9, phrase_final_decay_db: 6.3, rising_statements_share: 0.16 } },
  { id: "a1b2c3d4-0005-4a00-8000-000000000005", seed: 105, type: "training", type_source: "default", title: "Лифт за 60 секунд", duration_sec: 62, daysAgo: 6, hour: 9, minute: 40, status: "ready", has_system_track: false, training_task_id: "elevator_60",
    layer2: { pitch_range_st: 5.2, phrase_final_decay_db: 3.9, rising_statements_share: 0.08 } },
  { id: "a1b2c3d4-0006-4a00-8000-000000000006", seed: 106, type: "interview", type_source: "llm", title: "Интервью в «Самокат»", duration_sec: 2400, daysAgo: 4, hour: 15, minute: 0, status: "ready", has_system_track: true,
    layer2: { pitch_range_st: 3.6, phrase_final_decay_db: 6.9, rising_statements_share: 0.21, loudness_drift_db: -3.9 } },
  { id: MAIN_MEETING_ID, seed: 7, type: "pitch", type_source: "llm", title: "Питч фонду «Восход»", duration_sec: 1930, daysAgo: 1, hour: 14, minute: 30, status: "ready", has_system_track: true, scenario: "pitch",
    layer2: { pitch_median_hz: 118, pitch_range_st: 3.1, phrase_final_decay_db: 7.4, rising_statements_share: 0.17, jitter_pct: 1.21, shimmer_pct: 4.7, start_jitter_ratio: 1.38, loudness_drift_db: -3.4, loudness_mean_db: -24.6 } },
  { id: "a1b2c3d4-0008-4a00-8000-000000000008", seed: 108, type: "demo", type_source: "default", title: "Демо «Кухня на районе»", duration_sec: 1120, daysAgo: 0, hour: 11, minute: 10, minutesAgo: 190, status: "analyzing", has_system_track: true },
  { id: "a1b2c3d4-0009-4a00-8000-000000000009", seed: 109, type: "other", type_source: "default", title: null, duration_sec: 660, daysAgo: 0, hour: 12, minute: 40, minutesAgo: 95, status: "error", has_system_track: false,
    error: "Движок завершился с ошибкой на стадии «распознавание»: модель large-v3-turbo не найдена в кэше и не скачалась (нет сети). Проверьте движок в настройках или скачайте модель заранее." },
  { id: "a1b2c3d4-0010-4a00-8000-000000000010", seed: 110, type: "other", type_source: "default", title: null, duration_sec: 372, daysAgo: 0, hour: 13, minute: 25, minutesAgo: 20, status: "recorded", has_system_track: false },
];

export function specDate(spec: MockMeetingSpec, now: Date): string {
  const d = new Date(now);
  if (spec.minutesAgo != null) {
    d.setMinutes(d.getMinutes() - spec.minutesAgo, 0, 0);
    return toIsoLocal(d);
  }
  d.setDate(d.getDate() - spec.daysAgo);
  d.setHours(spec.hour, spec.minute, 0, 0);
  return toIsoLocal(d);
}

export function toIsoLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

export function buildPatterns(meetingIds: string[], generatedAt: string): PatternsResult {
  const last = meetingIds.slice(-4);
  const exercises: Exercise[] = [
    { title: "Пауза вместо «э‑э» на вопросе", instruction: "Попроси коллегу задать три неудобных вопроса подряд. После каждого — секунда тишины, потом ответ. Записывай в тренажёре, цель — ноль заполненных пауз за 45 секунд.", duration_min: 5, targets_metric: "layer1.filled_pauses_per_min", training_task_id: "answer_45" },
    { title: "Первая фраза — медленно", instruction: "Перед каждым созвоном проговори первую фразу вслух в темпе 100 слов в минуту: точка после первого предложения, пауза, второе предложение.", duration_min: 2, targets_metric: "layer1.wpm", training_task_id: "slow_120" },
    { title: "Три тона в истории", instruction: "Расскажи одну и ту же историю трижды: нейтрально, с удивлением, с сомнением. Смотри на диапазон тона — цель ≥ 6 полутонов.", duration_min: 4, targets_metric: "layer2.pitch_range_st", training_task_id: "pitch_range_60" },
  ];
  return {
    schema_version: 1,
    generated_at: generatedAt,
    meetings_used: meetingIds,
    insights: [
      { title: "Третий созвон подряд ты частишь в первые две минуты", detail: "На питче, интервью и демо первые 90 секунд идут на 150+ словах в минуту, дальше темп сам выравнивается до 125–135. Это волнение на старте, а не привычка говорить быстро — лечится одной заранее проговоренной первой фразой.", metric: "layer1.wpm", meeting_ids: last.slice(-3) },
      { title: "Заполненные паузы приходят гроздьями после вопросов", detail: "В спокойном рассказе у тебя 1–1,5 «э‑э» в минуту, но в двух минутах после неудобного вопроса — до семи. Проблема не в речи, а в отсутствии домашней заготовки на предсказуемые вопросы: юнит‑экономика, конкуренты, деньги.", metric: "layer1.filled_pauses_per_min", meeting_ids: last.slice(-2) },
      { title: "Диапазон тона ниже базы на длинных встречах", detail: "На встречах длиннее 25 минут диапазон тона падает до 3,1–3,6 полутонов против 4,6 в базе. Вторая половина звучит монотонно — слушателю кажется, что ты устал от собственного рассказа.", metric: "layer2.pitch_range_st", meeting_ids: last.filter((_, i) => i % 2 === 0) },
    ],
    weekly_summary: [
      "## Неделя",
      "Четыре записи: стендап, тренировка, интервью и питч. Оценка держится в диапазоне 62–84, лучший результат — тренировка «Лифт за 60 секунд».",
      "",
      "- **Что стало лучше:** структурные паузы — 3,9 в минуту против 3,2 в базе, речь стала ритмичнее",
      "- **Что просело:** заполненные паузы на вопросах, диапазон тона на длинных встречах",
      "- **Одна вещь на следующую неделю:** заготовка на три предсказуемых вопроса и секунда тишины перед ответом",
    ].join("\n"),
    exercises,
    backend: "claude_cli",
  };
}

export function buildPrep(topic: string, type: MeetingType): PrepResult {
  const t = topic.trim() || "встреча";
  const byType: Record<string, { checklist: string[]; q: PrepResult["likely_questions"] }> = {
    pitch: {
      checklist: [
        `Первая фраза про «${t}» — одно предложение, проговорить вслух в темпе 100 слов в минуту`,
        "Три числа юнит‑экономики наизусть: выручка с клиента, стоимость привлечения, окупаемость",
        "Одна таблица «мы vs конкуренты» — три строки, без прилагательных",
        "На что пойдут деньги: две статьи расходов и две вехи с датами",
        "Ответ на «почему сейчас» — в одном предложении",
        "Заготовка на «не знаю»: «не знаю, проверю и напишу до четверга»",
        "Секунда тишины перед ответом на любой вопрос вместо «э‑э»",
      ],
      q: [
        { question: "Сколько вы зарабатываете с одного клиента и сколько стоит его привлечь?", why: "Проверка, считаешь ли ты экономику на одном клиенте, а не на рынке.", how_to_prepare: "Три числа и одна фраза про окупаемость. Про размер рынка — только если спросят отдельно." },
        { question: "Чем вы отличаетесь от конкурентов?", why: "Инвестор хочет услышать названия и одну конкретную разницу, а не «мы лучше».", how_to_prepare: "Назови двух конкурентов и одну вещь, которую они не могут сделать по структурной причине." },
        { question: "На что пойдут деньги раунда?", why: "Проверка, есть ли план, а не просто желание расти.", how_to_prepare: "Две статьи расходов в процентах и две вехи с месяцами." },
      ],
    },
    demo: {
      checklist: [
        `Сценарий демо «${t}» — три экрана, не больше, каждый отвечает на боль клиента`,
        "Данные в демо — похожие на клиентские, не «тест тест»",
        "Сравнение с конкурентом — одна таблица, три строки",
        "Ответ на «сколько стоит внедрение» — цифра и срок",
        "План пилота: что делаем в первые две недели",
        "Пауза после каждого экрана: «есть вопросы по этому шагу?»",
      ],
      q: [
        { question: "А это работает с нашей учётной системой?", why: "Главный страх клиента — внедрение, а не функции.", how_to_prepare: "Список интеграций и честный срок подключения новой." },
        { question: "Чем это лучше того, что у нас уже есть?", why: "Клиент сравнивает не с конкурентом, а со своим текущим процессом.", how_to_prepare: "Одна цифра экономии в месяц на его объёме." },
        { question: "Сколько стоит и что нужно от нас?", why: "Без цифры и списка действий решение не примут.", how_to_prepare: "Цена на его объёме и три шага с их стороны." },
      ],
    },
    interview: {
      checklist: [
        `Рассказ о себе под «${t}» — 90 секунд, три проекта, по одному результату на каждый`,
        "Дыра в резюме — объяснение в одном предложении, без оправданий",
        "Почему ушёл с прошлого места — нейтрально и коротко",
        "Три вопроса интервьюеру про команду и задачи",
        "Один провал и что из него вынес",
        "Ожидания по деньгам — цифра, а не «обсуждаемо»",
      ],
      q: [
        { question: "Расскажите про самый сложный проект", why: "Проверяют глубину, а не список технологий.", how_to_prepare: "Одна история: контекст, решение, результат в цифрах, за две минуты." },
        { question: "Почему вы ушли с прошлого места?", why: "Ищут конфликтность и мотивацию.", how_to_prepare: "Одно предложение про рост, без критики бывших коллег." },
        { question: "Что вы будете делать в первые 90 дней?", why: "Проверяют, думал ли ты о роли, а не о собеседовании.", how_to_prepare: "Три шага: разобраться, починить одно, предложить одно." },
      ],
    },
  };
  const g = byType[type] ?? {
    checklist: [
      `Цель встречи «${t}» — одно предложение: что должно измениться после неё`,
      "Три тезиса, которые надо донести, в порядке важности",
      "Один вопрос, который точно зададут, и ответ на него",
      "Договорённости: что фиксируем в конце и кто ответственный",
      "Первая фраза — медленно, с паузой после",
    ],
    q: [
      { question: "Как это выглядит на практике?", why: "Абстракции не продаются, нужен пример.", how_to_prepare: "Один конкретный случай с цифрами." },
      { question: "Что нужно от нас, чтобы начать?", why: "Собеседник хочет понять цену своего участия.", how_to_prepare: "Три шага и сроки." },
      { question: "Какие риски?", why: "Проверка честности и подготовки.", how_to_prepare: "Два риска и что делаешь с каждым." },
    ],
  };
  return { topic: t, meeting_type: type, checklist: g.checklist, likely_questions: g.q, backend: "claude_cli" };
}

export function buildDoctor(settings: Settings): EngineDoctor {
  return {
    ok: true,
    python: settings.engine_python ?? "/Users/me/remarka/engine/.venv/bin/python",
    engine_version: "0.1.0",
    asr_model_cached: settings.asr_model === "large-v3-turbo" || settings.asr_model === "small",
    llm_backend_available: settings.llm_backend !== "anthropic_api" || !!settings.anthropic_api_key,
    messages: [
      "Python 3.11.9, faster-whisper 1.2.1, parselmouth 0.4.5",
      settings.asr_model === "large-v3-turbo" || settings.asr_model === "small"
        ? `Модель ${settings.asr_model} есть в кэше`
        : `Модель ${settings.asr_model} не скачана — нажмите «Скачать»`,
      settings.llm_backend === "claude_cli" ? "claude CLI найден: /opt/homebrew/bin/claude" : settings.llm_backend === "anthropic_api" ? (settings.anthropic_api_key ? "Ключ API задан" : "Ключ API не задан") : "Слой смысла выключен",
    ],
  };
}
