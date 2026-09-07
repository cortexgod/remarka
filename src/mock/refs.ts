/** Ориентиры по типам встреч — таблица §4.5 CONTRACTS.md (копия для mock). */
import type { MeetingType, MetricValue } from "../types/contracts.ts";

type Ref = [number | null, number | null] | null; // [low, high]; null = не оценивается

type RefTable = Record<string, Partial<Record<MeetingType | "default", Ref>>>;

const T: RefTable = {
  "layer1.wpm": { default: [100, 130], pitch: [110, 140], demo: [110, 140], standup: [110, 150], lecture: [90, 120] },
  "layer1.articulation_wpm": { default: [130, 170], lecture: [120, 160] },
  "layer1.filled_pauses_per_min": { default: [null, 3], pitch: [null, 2], interview: [null, 2], standup: [null, 4], lecture: [null, 2], one_on_one: [null, 4], training: [null, 1] },
  "layer1.crutch_words_per_min": { default: [null, 2], standup: [null, 3], one_on_one: [null, 3], training: [null, 1] },
  "layer1.structural_pauses_per_min": { default: [3, 6], lecture: [4, 8] },
  "layer1.hesitation_pauses_per_min": { default: [null, 4], training: [null, 3] },
  "layer1.talk_ratio": { default: [0.4, 0.7], pitch: [0.7, 0.8], demo: [0.6, 0.75], sales: [0.4, 0.45], interview: [0.5, 0.7], standup: [0.1, 0.4], lecture: [0.85, 1.0], one_on_one: [0.4, 0.6], training: null },
  "layer1.mean_sentence_len": { default: [null, 22] },
  "layer1.long_sentences_share": { default: [null, 0.2] },
  "layer1.mtld": { default: [60, null], standup: null, lecture: [70, null], training: null },
  "layer1.interruptions_by_me": { default: [null, 2], sales: [null, 1], interview: [null, 1], training: null },
  "layer2.pitch_range_st": { default: [4, null], lecture: [5, null] },
  "layer2.phrase_final_decay_db": { default: [null, 6] },
  "layer2.rising_statements_share": { default: [null, 0.15] },
  "layer2.loudness_drift_db": { default: [-3, null] },
};

export function refFor(key: string, type: MeetingType): [number | null, number | null] {
  const row = T[key];
  if (!row) return [null, null];
  const r = row[type] !== undefined ? row[type] : row.default;
  if (r === null || r === undefined) return [null, null];
  return r;
}

export function betterFor(key: string, lo: number | null, hi: number | null): MetricValue["better"] {
  if (lo != null && hi != null) return "inside";
  if (hi != null) return "lower";
  if (lo != null) return "higher";
  // без ориентира — по смыслу метрики
  if (/jitter|shimmer|decay|hesitation|filled|crutch|long_sentences|rising|interruptions/.test(key)) return "lower";
  if (/mtld|pitch_range|loudness_drift/.test(key)) return "higher";
  return "inside";
}

/** Статус по §4: good внутри, warn ≤ 20 % ширины (или границы), bad дальше, na без значения/ориентира. */
export function statusFor(value: number | null, lo: number | null, hi: number | null): MetricValue["status"] {
  if (value == null) return "na";
  if (lo == null && hi == null) return "na";
  if (lo != null && hi != null) {
    if (value >= lo && value <= hi) return "good";
    const w = Math.max(hi - lo, 1e-9) * 0.2;
    const d = value < lo ? lo - value : value - hi;
    return d <= w ? "warn" : "bad";
  }
  if (hi != null) {
    if (value <= hi) return "good";
    return value - hi <= Math.max(Math.abs(hi), 1e-9) * 0.2 ? "warn" : "bad";
  }
  if (value >= lo!) return "good";
  return lo! - value <= Math.max(Math.abs(lo!), 1e-9) * 0.2 ? "warn" : "bad";
}

/** Штраф по §4.6: 0 внутри; линейно до 1 при отклонении на 100 % ширины (одностороннее — от границы, ширина ≥ 1). */
export function penaltyFor(value: number | null, lo: number | null, hi: number | null): number {
  if (value == null) return 0;
  if (lo == null && hi == null) return 0;
  let width: number;
  let d: number;
  if (lo != null && hi != null) {
    width = Math.max(hi - lo, 1e-9);
    d = value < lo ? lo - value : value > hi ? value - hi : 0;
  } else if (hi != null) {
    width = Math.max(Math.abs(hi), 1);
    d = Math.max(0, value - hi);
  } else {
    width = Math.max(Math.abs(lo!), 1);
    d = Math.max(0, lo! - value);
  }
  return Math.min(1, d / width);
}

export const SCORE_WEIGHTS: Record<string, number> = {
  "layer1.filled_pauses_per_min": 20,
  "layer1.wpm": 15,
  "layer2.pitch_range_st": 15,
  "layer1.crutch_words_per_min": 10,
  "layer1.hesitation_pauses_per_min": 10,
  "layer1.talk_ratio": 10,
  "layer2.phrase_final_decay_db": 5,
  "layer2.rising_statements_share": 5,
  "layer1.long_sentences_share": 5,
  "layer1.interruptions_by_me": 5,
};

export const BASELINE_KEYS = [
  "layer1.wpm",
  "layer1.articulation_wpm",
  "layer1.filled_pauses_per_min",
  "layer1.crutch_words_per_min",
  "layer1.hesitation_pauses_per_min",
  "layer1.structural_pauses_per_min",
  "layer1.talk_ratio",
  "layer1.mean_sentence_len",
  "layer2.pitch_range_st",
  "layer2.phrase_final_decay_db",
  "layer2.rising_statements_share",
  "layer2.jitter_pct",
  "layer2.shimmer_pct",
  "layer2.loudness_drift_db",
];
