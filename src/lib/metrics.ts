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
  how: string;
  /** отображение значения */
  fmt?: (v: number) => string;
  /** значение в графике прогресса (без форматирования) */
  chart?: boolean;
}

const pct = (v: number) => fmtPct(v, 0);

export const METRIC_DEFS: MetricDef[] = [
  { key: "layer1.wpm", label: "Темп речи", short: "темп", unit: "сл/мин", digits: 0, group: "layer1", chart: true,
    how: "Слова без филлеров на минуту моей речи, медиана по окнам 15 с" },
  { key: "layer1.articulation_wpm", label: "Артикуляционный темп", short: "артикуляция", unit: "сл/мин", digits: 0, group: "layer1",
    how: "То же, но без пауз вовсе: отделяет «тараторит» от «не делает пауз»" },
  { key: "layer1.filled_pauses_total", label: "Заполненные паузы, всего", short: "э‑э всего", unit: "", digits: 0, group: "layer1",
    how: "«э‑э», «м‑м» — по транскрипту и по сигналу (детектор)" },
  { key: "layer1.filled_pauses_per_min", label: "Заполненные паузы", short: "э‑э в мин", unit: "в мин", digits: 1, group: "layer1", chart: true,
    how: "Заполненные паузы на минуту моей речи" },
  { key: "layer1.crutch_words_total", label: "Слова‑костыли, всего", short: "костыли всего", unit: "", digits: 0, group: "layer1",
    how: "«как бы», «типа», «на самом деле», «вот», «собственно» и другие по словарю" },
  { key: "layer1.crutch_words_per_min", label: "Слова‑костыли", short: "костыли в мин", unit: "в мин", digits: 1, group: "layer1", chart: true,
    how: "Слова‑костыли на минуту моей речи" },
  { key: "layer1.structural_pauses_per_min", label: "Структурные паузы", short: "структурные паузы", unit: "в мин", digits: 1, group: "layer1", chart: true,
    how: "Паузы ≥ 0,8 с на границе мысли. Их должно быть много" },
  { key: "layer1.hesitation_pauses_per_min", label: "Хезитационные паузы", short: "хезитации", unit: "в мин", digits: 1, group: "layer1", chart: true,
    how: "Паузы 0,3–0,8 с внутри синтагмы — там, где паузы быть не должно" },
  { key: "layer1.talk_ratio", label: "Доля своей речи", short: "доля речи", unit: "%", digits: 0, group: "layer1", fmt: pct, chart: true,
    how: "Моя речь / (моя + собеседника) по двум дорожкам. Нет без системного звука" },
  { key: "layer1.mean_sentence_len", label: "Длина предложения", short: "длина фразы", unit: "слов", digits: 1, group: "layer1", chart: true,
    how: "Среднее число слов в предложении без филлеров" },
  { key: "layer1.long_sentences_share", label: "Длинные предложения", short: "длинные фразы", unit: "%", digits: 0, group: "layer1", fmt: pct,
    how: "Доля предложений длиннее 22 слов" },
  { key: "layer1.mtld", label: "Лексическое разнообразие", short: "MTLD", unit: "", digits: 0, group: "layer1",
    how: "MTLD (McCarthy & Jarvis): не зависит от длины текста, в отличие от TTR" },
  { key: "layer1.interruptions_by_me", label: "Перебивал я", short: "перебивал я", unit: "", digits: 0, group: "layer1",
    how: "Пересечение речи на двух дорожках ≥ 0,5 с, когда собеседник говорил ≥ 1 с" },
  { key: "layer1.interruptions_by_other", label: "Перебивали меня", short: "перебивали меня", unit: "", digits: 0, group: "layer1",
    how: "Симметрично: собеседник начал, пока я говорил" },
  { key: "layer1.my_speech_sec", label: "Моя речь", short: "моя речь", unit: "с", digits: 0, group: "layer1",
    how: "Сумма речевых сегментов VAD по микрофону" },
  { key: "layer1.other_speech_sec", label: "Речь собеседника", short: "речь собеседника", unit: "с", digits: 0, group: "layer1",
    how: "Сумма речевых сегментов по системной дорожке" },
  { key: "layer1.words_total", label: "Слов всего", short: "слов", unit: "", digits: 0, group: "layer1",
    how: "Слова без филлеров" },
  { key: "layer2.pitch_median_hz", label: "Медиана тона", short: "тон", unit: "Гц", digits: 0, group: "layer2",
    how: "Медиана основного тона по озвонченным кадрам моей речи" },
  { key: "layer2.pitch_range_st", label: "Диапазон тона", short: "диапазон тона", unit: "пт", digits: 1, group: "layer2", chart: true,
    how: "P90 − P10 основного тона в полутонах. Меньше — монотонность" },
  { key: "layer2.phrase_final_decay_db", label: "Затухание к концу фразы", short: "затухание", unit: "дБ", digits: 1, group: "layer2", chart: true,
    how: "Медианное падение громкости на последних 0,5 с фразы. «Съедание» окончаний" },
  { key: "layer2.rising_statements_share", label: "Восходящие утверждения", short: "восходящие", unit: "%", digits: 0, group: "layer2", fmt: pct, chart: true,
    how: "Доля утверждений, где тон в конце выше на ≥ 2 пт — звучит как вопрос" },
  { key: "layer2.jitter_pct", label: "Джиттер", short: "джиттер", unit: "%", digits: 2, group: "layer2",
    how: "Микронестабильность частоты тона. Относительно себя (по базе)" },
  { key: "layer2.shimmer_pct", label: "Шиммер", short: "шиммер", unit: "%", digits: 2, group: "layer2",
    how: "Микронестабильность амплитуды. Относительно себя (по базе)" },
  { key: "layer2.start_jitter_ratio", label: "Джиттер старта", short: "джиттер старта", unit: "×", digits: 2, group: "layer2",
    how: "Джиттер первых 2 минут / остального: волнение на старте" },
  { key: "layer2.loudness_drift_db", label: "Дрейф громкости", short: "дрейф громкости", unit: "дБ", digits: 1, group: "layer2", chart: true,
    how: "Вторая половина минус первая: видно, как человек «сдувается»" },
  { key: "layer2.loudness_mean_db", label: "Средняя громкость", short: "громкость", unit: "дБ", digits: 1, group: "layer2",
    how: "Средняя интенсивность моей речи" },
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

/** Ориентир текстом: «110–140», «≤ 2», «≥ 4», «—» */
export function refText(key: string, mv: MetricValue | null | undefined): string {
  if (!mv) return "—";
  const def = metricDef(key);
  const f = (x: number) => (def?.fmt ? def.fmt(x) : fmtNum(x, def?.digits ?? 1));
  if (mv.ref_low != null && mv.ref_high != null) {
    if (def?.fmt) return `${fmtNum(mv.ref_low * 100, 0)}–${fmtNum(mv.ref_high * 100, 0)} %`;
    return `${f(mv.ref_low)}–${f(mv.ref_high)}`;
  }
  if (mv.ref_high != null) return `≤ ${f(mv.ref_high)}`;
  if (mv.ref_low != null) return `≥ ${f(mv.ref_low)}`;
  return "—";
}

export const STATUS_TEXT: Record<MetricValue["status"], string> = {
  good: "в норме",
  warn: "на грани",
  bad: "вне ориентира",
  na: "нет ориентира",
};

/** Ключи для графиков прогресса — в порядке важности */
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

/** Направление «хорошо» для дельт: true — рост это хорошо */
export function higherIsBetter(mv: MetricValue | null): boolean | null {
  if (!mv) return null;
  if (mv.better === "higher") return true;
  if (mv.better === "lower") return false;
  return null;
}
