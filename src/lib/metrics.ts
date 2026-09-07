import type { Metrics, MetricValue, Report } from "../types/contracts";
import { fmtNum, fmtPct } from "./format";

export type MetricGroup = "layer1" | "layer2";

export interface MetricDef {
  key: string; // "layer1.wpm"
  label: string;
  short: string;
  unit: string;
  digits: number;
  group: MetricGroup;
  /** объяснение простыми словами: что это и почему важно */
  how: string;
  /** отображение значения */
  fmt?: (v: number) => string;
  /** значение в графике прогресса (без форматирования) */
  chart?: boolean;
  /** показывать только в «подробностях» */
  advanced?: boolean;
}

const pct = (v: number) => fmtPct(v, 0);

// Подписи — человеческим языком. Точные формулы — в docs/CONTRACTS.md §4.
export const METRIC_DEFS: MetricDef[] = [
  { key: "layer1.wpm", label: "Темп речи", short: "темп", unit: "слов/мин", digits: 0, group: "layer1", chart: true,
    how: "Сколько слов в минуту ты говоришь. Слишком быстро — слушатель не успевает, слишком медленно — скучает" },
  { key: "layer1.articulation_wpm", label: "Темп без пауз", short: "без пауз", unit: "слов/мин", digits: 0, group: "layer1", advanced: true,
    how: "Скорость самой речи, если убрать все паузы. Показывает, ты тараторишь или просто не делаешь пауз" },
  { key: "layer1.filled_pauses_total", label: "«Э‑э» и «м‑м», всего", short: "э‑э всего", unit: "", digits: 0, group: "layer1", advanced: true,
    how: "Сколько раз за встречу" },
  { key: "layer1.filled_pauses_per_min", label: "«Э‑э» и «м‑м»", short: "э‑э в мин", unit: "в минуту", digits: 1, group: "layer1", chart: true,
    how: "Сколько раз за минуту твоей речи. Самая заметная для слушателя вещь" },
  { key: "layer1.crutch_words_total", label: "Слова‑паразиты, всего", short: "паразиты всего", unit: "", digits: 0, group: "layer1", advanced: true,
    how: "«как бы», «типа», «ну», «вот», «на самом деле» и похожие" },
  { key: "layer1.crutch_words_per_min", label: "Слова‑паразиты", short: "паразиты в мин", unit: "в минуту", digits: 1, group: "layer1", chart: true,
    how: "«как бы», «типа», «ну», «вот» и похожие — сколько раз за минуту речи" },
  { key: "layer1.structural_pauses_per_min", label: "Паузы между мыслями", short: "паузы между мыслями", unit: "в минуту", digits: 1, group: "layer1", chart: true,
    how: "Паузы после законченной мысли. Это хорошо: они дают слушателю время понять" },
  { key: "layer1.hesitation_pauses_per_min", label: "Запинки", short: "запинки", unit: "в минуту", digits: 1, group: "layer1", chart: true,
    how: "Короткие паузы посреди фразы, там где их быть не должно. Звучат как неуверенность" },
  { key: "layer1.talk_ratio", label: "Доля твоей речи", short: "доля речи", unit: "%", digits: 0, group: "layer1", fmt: pct, chart: true,
    how: "Сколько времени говорил ты, а сколько собеседник. Считается, только если записаны собеседники" },
  { key: "layer1.mean_sentence_len", label: "Длина фразы", short: "длина фразы", unit: "слов", digits: 1, group: "layer1", chart: true,
    how: "Среднее число слов в предложении. Длиннее 22 слов — слушатель теряет начало, пока дойдёт до конца" },
  { key: "layer1.long_sentences_share", label: "Длинные фразы", short: "длинные фразы", unit: "%", digits: 0, group: "layer1", fmt: pct, advanced: true,
    how: "Доля предложений длиннее 22 слов" },
  { key: "layer1.mtld", label: "Разнообразие слов", short: "разнообразие", unit: "", digits: 0, group: "layer1", advanced: true,
    how: "Насколько разными словами ты говоришь. Чем выше, тем богаче речь" },
  { key: "layer1.interruptions_by_me", label: "Перебивал я", short: "перебивал я", unit: "раз", digits: 0, group: "layer1",
    how: "Сколько раз ты начал говорить, пока собеседник ещё говорил" },
  { key: "layer1.interruptions_by_other", label: "Перебивали меня", short: "перебивали меня", unit: "раз", digits: 0, group: "layer1",
    how: "Сколько раз собеседник начал говорить, пока говорил ты" },
  { key: "layer1.my_speech_sec", label: "Ты говорил", short: "ты говорил", unit: "с", digits: 0, group: "layer1", advanced: true,
    how: "Сколько секунд звучала твоя речь" },
  { key: "layer1.other_speech_sec", label: "Говорил собеседник", short: "собеседник", unit: "с", digits: 0, group: "layer1", advanced: true,
    how: "Сколько секунд звучала речь собеседника" },
  { key: "layer1.words_total", label: "Слов всего", short: "слов", unit: "", digits: 0, group: "layer1", advanced: true,
    how: "Слова без «э‑э» и «м‑м»" },
  { key: "layer2.pitch_median_hz", label: "Высота голоса", short: "высота", unit: "Гц", digits: 0, group: "layer2", advanced: true,
    how: "Обычная высота твоего голоса. Сама по себе ни хорошая, ни плохая" },
  { key: "layer2.pitch_range_st", label: "Живость интонации", short: "интонация", unit: "полутонов", digits: 1, group: "layer2", chart: true,
    how: "Насколько голос ходит вверх и вниз. Меньше 4 полутонов — звучит монотонно, и слушатель отключается" },
  { key: "layer2.phrase_final_decay_db", label: "Проглатывание окончаний", short: "окончания", unit: "дБ", digits: 1, group: "layer2", chart: true,
    how: "Насколько тише становится голос к концу фразы. Люди этого за собой не слышат" },
  { key: "layer2.rising_statements_share", label: "Утверждения как вопросы", short: "вопросительный тон", unit: "%", digits: 0, group: "layer2", fmt: pct, chart: true,
    how: "Доля фраз, где голос уходит вверх в конце, и утверждение звучит как вопрос — то есть неуверенно" },
  { key: "layer2.jitter_pct", label: "Дрожание голоса", short: "дрожание", unit: "%", digits: 2, group: "layer2", advanced: true,
    how: "Мелкие колебания высоты голоса. Сравнивается только с тобой обычным, нормы нет" },
  { key: "layer2.shimmer_pct", label: "Дрожание громкости", short: "дрожание громкости", unit: "%", digits: 2, group: "layer2", advanced: true,
    how: "Мелкие колебания громкости. Сравнивается только с тобой обычным" },
  { key: "layer2.start_jitter_ratio", label: "Волнение в начале", short: "волнение в начале", unit: "×", digits: 2, group: "layer2", advanced: true,
    how: "Дрожание голоса в первые две минуты по сравнению с остальной встречей. Больше 1 — на старте ты волновался" },
  { key: "layer2.loudness_drift_db", label: "Громкость к концу", short: "громкость к концу", unit: "дБ", digits: 1, group: "layer2", chart: true,
    how: "Стал ли ты тише ко второй половине встречи. Минус — «сдулся»" },
  { key: "layer2.loudness_mean_db", label: "Громкость", short: "громкость", unit: "дБ", digits: 1, group: "layer2", advanced: true,
    how: "Средняя громкость твоей речи" },
];

export const METRIC_BY_KEY: Record<string, MetricDef> = Object.fromEntries(METRIC_DEFS.map((d) => [d.key, d]));

export function metricDef(key: string | null | undefined): MetricDef | null {
  return key ? METRIC_BY_KEY[key] ?? null : null;
}

export function metricLabel(key: string | null | undefined): string {
  return metricDef(key)?.label ?? key ?? "";
}

export function getMetric(metrics: Metrics | undefined | null, key: string): MetricValue | null {
  if (!metrics) return null;
  const [group, name] = key.split(".");
  const g = (metrics as unknown as Record<string, Record<string, MetricValue>>)[group];
  const v = g?.[name];
  return v && typeof v === "object" && "value" in v ? v : null;
}

export function reportMetric(report: Report | null | undefined, key: string): MetricValue | null {
  return getMetric(report?.metrics, key);
}

/** Форматированное значение метрики (без единицы, если fmt сам её ставит) */
export function fmtMetricValue(key: string, v: number | null | undefined): string {
  if (v == null) return "—";
  const def = metricDef(key);
  if (def?.fmt) return def.fmt(v);
  return fmtNum(v, def?.digits ?? 1);
}

/** Значение + единица */
export function fmtMetricFull(key: string, v: number | null | undefined): string {
  if (v == null) return "—";
  const def = metricDef(key);
  if (def?.fmt) return def.fmt(v);
  const s = fmtNum(v, def?.digits ?? 1);
  return def?.unit ? `${s} ${def.unit}` : s;
}

/** Норма текстом: «110–140», «до 2», «от 4», «—» */
export function refText(key: string, mv: MetricValue | null | undefined): string {
  if (!mv) return "—";
  const def = metricDef(key);
  const f = (x: number) => (def?.fmt ? def.fmt(x) : fmtNum(x, def?.digits ?? 1));
  if (mv.ref_low != null && mv.ref_high != null) {
    if (def?.fmt) return `${fmtNum(mv.ref_low * 100, 0)}–${fmtNum(mv.ref_high * 100, 0)} %`;
    return `${f(mv.ref_low)}–${f(mv.ref_high)}`;
  }
  if (mv.ref_high != null) return `до ${f(mv.ref_high)}`;
  if (mv.ref_low != null) return `от ${f(mv.ref_low)}`;
  return "—";
}

export const STATUS_TEXT: Record<MetricValue["status"], string> = {
  good: "хорошо",
  warn: "на грани",
  bad: "стоит поправить",
  na: "без нормы",
};

/** Ключи для графиков прогресса и целей профиля — в порядке важности */
export const PROGRESS_KEYS = [
  "layer1.wpm",
  "layer1.filled_pauses_per_min",
  "layer1.crutch_words_per_min",
  "layer2.pitch_range_st",
  "layer1.hesitation_pauses_per_min",
  "layer1.talk_ratio",
  "layer2.phrase_final_decay_db",
  "layer2.rising_statements_share",
];

/** Цели для профиля: что человек хочет улучшить */
export const GOAL_OPTIONS: { key: string; label: string }[] = [
  { key: "layer1.filled_pauses_per_min", label: "Меньше «э‑э» и «м‑м»" },
  { key: "layer1.crutch_words_per_min", label: "Меньше слов‑паразитов" },
  { key: "layer1.wpm", label: "Держать темп" },
  { key: "layer2.pitch_range_st", label: "Живее интонация" },
  { key: "layer1.hesitation_pauses_per_min", label: "Меньше запинок" },
  { key: "layer1.talk_ratio", label: "Больше слушать, меньше говорить" },
  { key: "layer2.phrase_final_decay_db", label: "Договаривать окончания" },
  { key: "layer2.rising_statements_share", label: "Утверждать, а не спрашивать" },
  { key: "layer1.mean_sentence_len", label: "Короче фразы" },
];

/** Направление «хорошо» для дельт: true — рост это хорошо */
export function higherIsBetter(mv: MetricValue | null): boolean | null {
  if (!mv) return null;
  if (mv.better === "higher") return true;
  if (mv.better === "lower") return false;
  return null;
}
