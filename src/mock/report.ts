/**
 * Генератор синтетического отчёта (Report) — детерминированный по seed.
 * Строит транскрипт из шаблонов, размещает слова по времени согласно кривой темпа,
 * вставляет филлеры/костыли/паузы/реплики собеседника и считает метрики по формулам §4.
 */
import type {
  Baseline,
  BaselineComparison,
  BaselineDelta,
  LlmBackend,
  Meaning,
  MeaningQuestion,
  MeetingType,
  MetricValue,
  Metrics,
  OtherUtterance,
  Report,
  Score,
  ScoreComponent,
  Sentence,
  SpeechEvent,
  ThreeThing,
  TimePoint,
  TimeSpan,
  Timeline,
  Word,
} from "../types/contracts.ts";
import { Rng, hashSeed } from "./rng.ts";
import { BASELINE_KEYS, SCORE_WEIGHTS, betterFor, penaltyFor, refFor, statusFor } from "./refs.ts";
import {
  CRUTCH_MID,
  CRUTCH_SET,
  CRUTCH_START,
  FILLERS,
  SLOTS,
  TEMPLATES,
  genericOtherLines,
  pitchOtherLines,
  type OtherLine,
  type Section,
} from "./text.ts";

export interface GenOptions {
  id: string;
  seed?: number;
  started_at: string;
  duration_sec: number;
  type: MeetingType;
  type_source?: "llm" | "user" | "default";
  title: string | null;
  has_system_track: boolean;
  training_task_id?: string | null;
  /** готовая база — тогда сравнение ready, иначе calibrating */
  baseline?: Baseline | null;
  calibrating_used?: number;
  asr_model?: string;
  llm_backend?: LlmBackend;
  llm_model?: string;
  data_dir?: string;
  /** переопределение чисел второго слоя */
  layer2?: Partial<Record<string, number | null>>;
  /** сценарий: pitch — полный (вопросы, гроздь пауз), generic — остальные типы */
  scenario?: "pitch" | "generic";
}

// ---------------------------------------------------------------------------
// вспомогательное
// ---------------------------------------------------------------------------

// союз «а» не считаем филлером — только протяжное «аа»/«а-а»
const FILLER_RE = /^(э+|эм+|м+|мм+|аа+|ээ+|хм+|гм+|ым+|э-э|э-э-э|м-м|а-а)$/;
const COND_CRUTCH = new Set(["ну", "вот", "значит", "просто", "то есть", "получается", "соответственно"]);

export function normToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}
function r3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function interp(points: [number, number][], t: number): number {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      return y0 + ((y1 - y0) * (t - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

function overlap(a: TimeSpan, b: TimeSpan): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function overlapSum(spans: TimeSpan[], w: TimeSpan): number {
  let s = 0;
  for (const sp of spans) s += overlap(sp, w);
  return s;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function fmtRu(v: number, digits = 1): string {
  return v.toFixed(digits).replace(".", ",");
}

/** MTLD (McCarthy & Jarvis 2010), порог 0,72, среднее forward/backward */
export function mtld(tokens: string[], threshold = 0.72): number | null {
  if (tokens.length < 50) return null;
  const one = (seq: string[]) => {
    let factors = 0;
    let count = 0;
    let types = new Set<string>();
    let ttr = 1;
    for (const tok of seq) {
      count++;
      types.add(tok);
      ttr = types.size / count;
      if (ttr <= threshold) {
        factors++;
        count = 0;
        types = new Set();
        ttr = 1;
      }
    }
    if (count > 0) factors += (1 - ttr) / (1 - threshold);
    return factors > 0 ? seq.length / factors : seq.length;
  };
  return (one(tokens) + one([...tokens].reverse())) / 2;
}

// ---------------------------------------------------------------------------
// сценарий
// ---------------------------------------------------------------------------

interface Scenario {
  sections: { section: Section; until: number; anchors?: string[] }[];
  other: OtherLine[];
  wpm: (t: number) => number; // желаемый темп (реальный, с паузами)
  fillerP: (t: number) => number;
  crutchStartP: (t: number) => number;
  crutchMidP: (t: number) => number;
  hesP: (t: number) => number;
  detectorP: number;
}

export const PITCH_ANCHORS = {
  A0: "Мы делаем Возвратку — сервис, который забирает у интернет-магазина всю боль с возвратами: от заявки покупателя до денег на счёте.",
  A1: "Э-э, ну, смотрите, рынок возвратов в России — это, как бы, сто двадцать миллиардов рублей в год, и он растёт на тридцать процентов.",
  A2: "И, э-э, поэтому мы, м-м, считаем, что, э-э, на этом рынке, э-э, можно построить компанию на миллиард.",
  A3: "Ну, у нас, на самом деле, нет прямых конкурентов, есть логисты, которые возят коробки, но они, как бы, не считают деньги.",
  A4: "Деньги пойдут на продажи и интеграции: три продавца, два инженера и восемнадцать месяцев на сто платящих магазинов.",
};

function pitchScenario(D: number): Scenario {
  const cl = (t: number) => t >= 851 && t < 1004; // после первого вопроса
  return {
    sections: [
      { section: "intro", until: 150, anchors: [PITCH_ANCHORS.A0] },
      { section: "problem", until: 330 },
      { section: "solution", until: 560 },
      { section: "traction", until: 828 },
      { section: "market", until: 1004, anchors: [PITCH_ANCHORS.A1, PITCH_ANCHORS.A2] },
      { section: "unit", until: 1238 },
      { section: "competitors", until: 1480, anchors: [PITCH_ANCHORS.A3] },
      { section: "team", until: 1596 },
      { section: "ask", until: 1800, anchors: [PITCH_ANCHORS.A4] },
      { section: "generic", until: D - 62 },
    ],
    other: pitchOtherLines(D),
    wpm: (t) =>
      interp(
        [
          [0, 164], [50, 162], [95, 154], [150, 148], [300, 149], [480, 142], [700, 138], [828, 136],
          [860, 104], [950, 108], [1004, 114], [1200, 142], [1238, 140], [1300, 146], [1400, 156],
          [1550, 160], [1600, 152], [1700, 140], [1800, 132], [D, 126],
        ],
        t,
      ),
    fillerP: (t) => (cl(t) ? 0.07 : t < 60 ? 0.012 : t < 1100 && t >= 1004 ? 0.018 : 0.003),
    crutchStartP: (t) => (cl(t) ? 0.35 : 0.12),
    crutchMidP: (t) => (cl(t) ? 0.25 : 0.1),
    hesP: (t) => (cl(t) ? 0.12 : 0.03),
    detectorP: 0.06,
  };
}

function genericScenario(D: number, type: MeetingType, hasSystem: boolean, rng: Rng): Scenario {
  const isTraining = type === "training";
  const base = isTraining ? rng.range(108, 125) : rng.range(112, 146);
  const startBump = rng.chance(0.75) ? rng.range(18, 32) : 0;
  const order: Section[] = type === "standup"
    ? ["generic", "generic", "traction", "generic"]
    : type === "interview"
      ? ["intro", "team", "problem", "solution", "generic", "traction", "generic"]
      : ["intro", "problem", "solution", "traction", "unit", "competitors", "team", "ask", "generic"];
  const sections: Scenario["sections"] = [];
  const n = Math.max(1, Math.min(order.length, Math.round(D / 140)));
  for (let i = 0; i < n; i++) sections.push({ section: order[i], until: ((i + 1) / n) * (D - (hasSystem ? 10 : 1)) });
  const wobble = [0.9, 1.05, 0.97, 1.08, 0.94, 1.02].map((w, i) => [((i + 1) / 7) * D, base * w] as [number, number]);
  const pts: [number, number][] = [[0, base + startBump], [90, base + startBump * 0.6], [150, base], ...wobble, [D, base * 0.95]];
  const fp = isTraining ? 0.004 : rng.range(0.008, 0.035);
  const cp = isTraining ? 0.05 : rng.range(0.1, 0.3);
  return {
    sections,
    other: hasSystem ? genericOtherLines(D, type) : [],
    wpm: (t) => interp(pts, t),
    fillerP: () => fp,
    crutchStartP: () => cp,
    crutchMidP: () => cp * 0.7,
    hesP: () => rng.range(0.02, 0.06),
    detectorP: 0.08,
  };
}

// ---------------------------------------------------------------------------
// генерация текста
// ---------------------------------------------------------------------------

interface Tok {
  text: string;
  norm: string;
  kind: Word["kind"];
  crutch?: string; // метка костыля (на первом слове)
  gapBefore?: number; // принудительная пауза перед токеном
}

function fillSlots(s: string, rng: Rng): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => rng.pick(SLOTS[k] ?? ["…"]));
}

/** Разметка костылей по нормализованным токенам (§4.1). */
function classify(toks: Tok[]): void {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === "filler" || t.crutch) continue;
    if (FILLER_RE.test(t.norm)) {
      t.kind = "filler";
      continue;
    }
    const bi = i + 1 < toks.length ? `${t.norm} ${toks[i + 1].norm}` : null;
    if (bi && CRUTCH_SET.has(bi)) {
      const cond = COND_CRUTCH.has(bi);
      if (!cond || i === 0 || /[,—:]$/.test(toks[i - 1].text)) {
        t.kind = "crutch";
        t.crutch = bi;
        if (cond && i > 0) t.gapBefore = Math.max(t.gapBefore ?? 0, 0.25);
        i++;
        continue;
      }
    }
    if (CRUTCH_SET.has(t.norm)) {
      const cond = COND_CRUTCH.has(t.norm);
      if (!cond || i === 0 || /[,—:]$/.test(toks[i - 1].text)) {
        t.kind = "crutch";
        t.crutch = t.norm;
        if (cond && i > 0) t.gapBefore = Math.max(t.gapBefore ?? 0, 0.25);
      }
    }
  }
}

function tokenize(text: string): Tok[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ({ text: w, norm: normToken(w), kind: "word" as const }));
}

function buildSentence(rng: Rng, sc: Scenario, section: Section, t: number, anchor?: string): Tok[] {
  if (anchor) {
    const toks = tokenize(anchor);
    classify(toks);
    return toks;
  }
  let text = fillSlots(rng.pick(TEMPLATES[section]), rng);
  // сделать часть фраз вопросами (риторика) — редко
  if (rng.chance(0.06) && text.endsWith(".")) text = text.slice(0, -1) + "?";
  let toks = tokenize(text);
  if (rng.chance(sc.crutchStartP(t))) {
    const c = rng.pick(CRUTCH_START);
    toks[0].text = toks[0].text[0].toLowerCase() + toks[0].text.slice(1);
    toks = [{ text: c, norm: normToken(c), kind: "word" }, ...toks];
  }
  if (toks.length > 6 && rng.chance(sc.crutchMidP(t))) {
    let pos = rng.int(2, toks.length - 3);
    if (/^[—–-]/.test(toks[pos].text)) pos++;
    if (!/[,.!?:;—]$/.test(toks[pos - 1].text)) toks[pos - 1].text += ",";
    const phrase = rng.pick(CRUTCH_MID).split(" ");
    const ins: Tok[] = phrase.map((p, i) => ({
      text: i === phrase.length - 1 ? p + "," : p,
      norm: normToken(p),
      kind: "word" as const,
    }));
    toks = [...toks.slice(0, pos), ...ins, ...toks.slice(pos)];
  }
  classify(toks);
  // филлеры
  const out: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (i > 0 && rng.chance(sc.fillerP(t))) {
      const f = rng.pick(FILLERS);
      out.push({ text: f + ",", norm: normToken(f), kind: "filler" });
    }
    out.push(toks[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// главный генератор
// ---------------------------------------------------------------------------

export function generateReport(o: GenOptions): Report {
  const D = o.duration_sec;
  const seed = o.seed ?? hashSeed(o.id);
  const rng = new Rng(seed);
  const scenarioKind = o.scenario ?? (o.type === "pitch" && D > 1500 ? "pitch" : "generic");
  const sc = scenarioKind === "pitch" ? pitchScenario(D) : genericScenario(D, o.type, o.has_system_track, rng);
  const other: OtherLine[] = o.has_system_track ? sc.other.filter((l) => l.at + l.dur < D) : [];

  const words: Word[] = [];
  const sentences: Sentence[] = [];
  const events: SpeechEvent[] = [];
  const structuralGaps: { t: number; end: number; sentence_i: number }[] = [];

  let t = other.length && other[0].at < 2 ? other[0].at + other[0].dur + rng.range(0.6, 1.2) : 0.6;
  let nextOther = other.length && other[0].at < 2 ? 1 : 0;

  const wordDur = (tok: Tok, tt: number): number => {
    const letters = tok.norm.replace(/-/g, "").length || 2;
    const base = Math.min(0.85, 0.09 + 0.05 * letters);
    const perWord = 60 / (sc.wpm(tt) * 1.21);
    return Math.max(0.12, Math.min(base, perWord * 0.82)) * rng.range(0.92, 1.08);
  };
  const gapAfter = (dur: number, tt: number): number => {
    const perWord = 60 / (sc.wpm(tt) * 1.21);
    return Math.max(0.02, perWord - dur) * rng.range(0.85, 1.15);
  };

  const skipOther = () => {
    while (nextOther < other.length && t >= other[nextOther].at - 0.05) {
      const b = other[nextOther];
      const back = b.interrupted_by_me ?? 0;
      t = b.at + b.dur - back + (back ? 0 : b.is_question ? rng.range(0.8, 1.7) : rng.range(0.5, 1.3));
      nextOther++;
    }
  };

  for (const sec of sc.sections) {
    const anchors = [...(sec.anchors ?? [])];
    let guard = 0;
    while (t < sec.until - 1.5 && guard++ < 2000) {
      skipOther();
      if (t >= D - 1.5) break;
      const anchor = anchors.shift();
      const toks = buildSentence(rng, sc, sec.section, t, anchor);
      const sIdx = sentences.length;
      const from = words.length;
      const sentStart = t;
      let truncated = false;
      for (let k = 0; k < toks.length; k++) {
        const tok = toks[k];
        const blk = nextOther < other.length ? other[nextOther] : null;
        // собеседник начал говорить: допускаем перекрытие только если он меня перебивает
        if (blk && t + 0.05 >= blk.at + (blk.interrupts_me ?? 0) && words.length > from + 2) {
          truncated = true;
          break;
        }
        if (blk && blk.interrupts_me && t >= blk.at && words.length === from) break;
        // хезитационная пауза внутри синтагмы
        if (k > 0 && tok.kind !== "filler" && !tok.gapBefore && rng.chance(sc.hesP(t))) {
          const g = rng.chance(0.12) ? rng.range(0.8, 1.4) : rng.range(0.3, 0.8);
          events.push({
            t: r2(t), end: r2(t + g), kind: "hesitation_pause",
            label: g >= 0.8 ? "long" : `${fmtRu(g)} с`,
            source: "signal", word_i: words.length, sentence_i: sIdx, value: r2(g),
          });
          t += g;
        } else if (tok.gapBefore) {
          t += tok.gapBefore;
        }
        const dur = tok.kind === "filler" ? rng.range(0.32, 0.7) : wordDur(tok, t);
        const w: Word = {
          i: words.length,
          start: r2(t),
          end: r2(t + dur),
          text: tok.text,
          norm: tok.norm,
          prob: r2(tok.kind === "filler" ? rng.range(0.42, 0.8) : rng.range(0.7, 0.995)),
          kind: tok.kind,
          sentence_i: sIdx,
        };
        words.push(w);
        if (tok.kind === "filler") {
          const src = rng.chance(0.55) ? "both" : "asr";
          events.push({ t: w.start, end: w.end, kind: "filled_pause", label: tok.norm, source: src, word_i: w.i, sentence_i: sIdx, value: r2(dur) });
        } else if (tok.kind === "crutch" && tok.crutch) {
          events.push({ t: w.start, end: w.end, kind: "crutch", label: tok.crutch, source: "asr", word_i: w.i, sentence_i: sIdx, value: null });
        }
        t += dur + (tok.kind === "filler" ? rng.range(0.08, 0.3) : gapAfter(dur, t));
      }
      if (words.length === from) {
        skipOther();
        continue;
      }
      const last = words[words.length - 1];
      if (truncated) last.text = last.text.replace(/[,.!?]+$/, "") + "…";
      const nWords = words.slice(from).filter((w) => w.kind !== "filler").length;
      const text = words.slice(from).map((w) => w.text).join(" ");
      sentences.push({
        i: sIdx, start: words[from].start, end: last.end, text,
        word_from: from, word_to: last.i, n_words: nWords, is_question: /\?$/.test(last.text),
      });
      // граница мысли: структурная или короткая пауза
      let pause: number;
      if (rng.chance(0.5)) {
        pause = rng.range(0.8, 2.1);
        events.push({ t: r2(last.end), end: r2(last.end + pause), kind: "structural_pause", label: `${fmtRu(pause)} с`, source: "signal", word_i: null, sentence_i: sIdx, value: r2(pause) });
        structuralGaps.push({ t: last.end, end: last.end + pause, sentence_i: sIdx });
      } else {
        pause = rng.range(0.25, 0.75);
      }
      t = last.end + pause;
      void sentStart;
    }
  }

  // детекторные филлеры (без слова ASR) внутри части структурных пауз
  for (const g of structuralGaps) {
    if (g.end - g.t > 1.1 && rng.chance(sc.detectorP)) {
      const s = g.t + rng.range(0.15, 0.35);
      const d = rng.range(0.3, 0.6);
      events.push({ t: r2(s), end: r2(s + d), kind: "filled_pause", label: rng.chance(0.7) ? "э-э" : "м-м", source: "detector", word_i: null, sentence_i: g.sentence_i, value: r2(d) });
    }
  }

  // сегменты речи (VAD)
  const micSpeech: TimeSpan[] = [];
  for (const w of words) {
    const lastSeg = micSpeech[micSpeech.length - 1];
    if (lastSeg && w.start - lastSeg.end < 0.35) lastSeg.end = w.end;
    else micSpeech.push({ start: w.start, end: w.end });
  }
  for (const e of events) if (e.kind === "filled_pause" && e.source === "detector") micSpeech.push({ start: e.t, end: e.end });
  micSpeech.sort((a, b) => a.start - b.start);
  const systemSpeech: TimeSpan[] = other.map((l) => ({ start: r2(l.at), end: r2(l.at + l.dur) }));

  // перебивания
  for (const l of other) {
    if (l.interrupts_me) events.push({ t: r2(l.at), end: r2(l.at + l.interrupts_me), kind: "interruption_by_other", label: `${fmtRu(l.interrupts_me)} с`, source: "signal", word_i: null, sentence_i: null, value: r2(l.interrupts_me) });
    if (l.interrupted_by_me) {
      const s = l.at + l.dur - l.interrupted_by_me;
      events.push({ t: r2(s), end: r2(l.at + l.dur), kind: "interruption_by_me", label: `${fmtRu(l.interrupted_by_me)} с`, source: "signal", word_i: null, sentence_i: null, value: r2(l.interrupted_by_me) });
    }
    if (l.is_question) events.push({ t: r2(l.at), end: r2(l.at + l.dur), kind: "question_from_other", label: l.text, source: "asr", word_i: null, sentence_i: null, value: null });
  }

  const otherUtt: OtherUtterance[] = other.map((l) => ({ start: r2(l.at), end: r2(l.at + l.dur), text: l.text, is_question: l.is_question }));

  // второй слой (значения — синтетика по seed, переопределяемая)
  const L2 = {
    pitch_median_hz: rng.range(108, 130),
    pitch_range_st: rng.range(2.8, 6.4),
    phrase_final_decay_db: rng.range(3.2, 8.2),
    rising_statements_share: rng.range(0.05, 0.24),
    jitter_pct: rng.range(0.8, 1.4),
    shimmer_pct: rng.range(3.4, 5.6),
    start_jitter_ratio: D < 240 ? null : rng.range(0.95, 1.5),
    loudness_drift_db: rng.range(-4.2, 0.8),
    loudness_mean_db: rng.range(-27, -22),
    ...(o.layer2 ?? {}),
  } as Record<string, number | null>;

  // просодические события
  const stmts = sentences.filter((s) => !s.is_question && s.end - s.start > 1);
  for (const s of stmts) {
    if (rng.chance(L2.rising_statements_share ?? 0.1)) {
      const st = rng.range(2.1, 4.6);
      events.push({ t: r2(s.end - 0.4), end: r2(s.end), kind: "rising_statement", label: `+${fmtRu(st)} пт`, source: "signal", word_i: s.word_to, sentence_i: s.i, value: r2(st) });
    }
    if (rng.chance(Math.max(0, ((L2.phrase_final_decay_db ?? 4) - 3) * 0.05))) {
      const db = rng.range(6.2, 12);
      events.push({ t: r2(s.end - 0.5), end: r2(s.end), kind: "decay", label: `−${fmtRu(db)} дБ`, source: "signal", word_i: s.word_to, sentence_i: s.i, value: r2(db) });
    }
  }

  // таймлайн
  const wpmPts: TimePoint[] = [];
  const artPts: TimePoint[] = [];
  const pitchPts: TimePoint[] = [];
  const loudPts: TimePoint[] = [];
  const nonFiller = words.filter((w) => w.kind !== "filler");
  let wi = 0;
  let pitchWalk = 0;
  let loudWalk = 0;
  const pitchScale = (L2.pitch_range_st ?? 4) / 4;
  for (let c = 7.5; c + 7.5 <= D + 1e-6; c += 5) {
    const w: TimeSpan = { start: c - 7.5, end: c + 7.5 };
    while (wi < nonFiller.length && nonFiller[wi].start < w.start) wi++;
    let n = 0;
    for (let j = wi; j < nonFiller.length && nonFiller[j].start < w.end; j++) n++;
    const otherT = overlapSum(systemSpeech, w);
    const myT = overlapSum(micSpeech, w);
    const avail = 15 - otherT;
    wpmPts.push({ t: c, v: n > 0 && avail > 0.5 ? Math.round(n / (avail / 60)) : 0 });
    artPts.push({ t: c, v: n > 0 && myT > 0.5 ? Math.round(n / (myT / 60)) : 0 });
    if (myT > 1) {
      pitchWalk = pitchWalk * 0.6 + rng.gauss(0, 0.9) * pitchScale;
      pitchPts.push({ t: c, v: r2(Math.max(-3.5, Math.min(3.5, pitchWalk)) * pitchScale) });
      loudWalk = loudWalk * 0.5 + rng.gauss(0, 0.7);
      loudPts.push({ t: c, v: r2((L2.loudness_mean_db ?? -25) + (L2.loudness_drift_db ?? 0) * (c / D - 0.5) + loudWalk) });
    }
  }
  const timeline: Timeline = {
    window_sec: 15, step_sec: 5, wpm: wpmPts, articulation_wpm: artPts, pitch_semitones: pitchPts, loudness_db: loudPts,
    other_speaking: systemSpeech,
  };

  // fast_burst: окна с wpm > ref_high × 1.2
  const [wpmLo, wpmHi] = refFor("layer1.wpm", o.type);
  if (wpmHi != null) {
    let run: TimePoint[] = [];
    const flush = () => {
      if (run.length) {
        const mx = Math.max(...run.map((p) => p.v));
        events.push({ t: r2(run[0].t - 7.5), end: r2(run[run.length - 1].t + 7.5), kind: "fast_burst", label: `${mx} сл/мин`, source: "signal", word_i: null, sentence_i: null, value: mx });
      }
      run = [];
    };
    for (const p of wpmPts) {
      if (p.v > wpmHi * 1.2) run.push(p);
      else flush();
    }
    flush();
  }
  void wpmLo;

  events.sort((a, b) => a.t - b.t);

  // метрики
  const mySpeechSec = micSpeech.reduce((s, x) => s + (x.end - x.start), 0);
  const otherSpeechSec = systemSpeech.reduce((s, x) => s + (x.end - x.start), 0);
  const myMin = Math.max(mySpeechSec / 60, 0.5);
  const turnMin = Math.max((D - otherSpeechSec) / 60, 0.5);
  const count = (k: SpeechEvent["kind"]) => events.filter((e) => e.kind === k).length;
  const wpmWin = wpmPts.filter((p) => p.v > 0);
  const artWin = artPts.filter((p) => p.v > 0);
  const crutchCounts = new Map<string, number>();
  for (const e of events) if (e.kind === "crutch") crutchCounts.set(e.label, (crutchCounts.get(e.label) ?? 0) + 1);
  const crutchTop = [...crutchCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word, cnt]) => ({ word, count: cnt }));
  const sentLens = sentences.map((s) => s.n_words).filter((n) => n > 0);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const raw: Record<string, { value: number | null; unit: string }> = {
    "layer1.wpm": { value: median(wpmWin.map((p) => p.v).filter((_, i) => i >= 0)), unit: "сл/мин" },
    "layer1.articulation_wpm": { value: median(artWin.map((p) => p.v)), unit: "сл/мин" },
    "layer1.filled_pauses_total": { value: count("filled_pause"), unit: "" },
    "layer1.filled_pauses_per_min": { value: r2(count("filled_pause") / myMin), unit: "в мин" },
    "layer1.crutch_words_total": { value: count("crutch"), unit: "" },
    "layer1.crutch_words_per_min": { value: r2(count("crutch") / myMin), unit: "в мин" },
    "layer1.structural_pauses_per_min": { value: r2(count("structural_pause") / turnMin), unit: "в мин" },
    "layer1.hesitation_pauses_per_min": { value: r2(count("hesitation_pause") / turnMin), unit: "в мин" },
    "layer1.talk_ratio": { value: o.has_system_track && mySpeechSec + otherSpeechSec > 0 ? r3(mySpeechSec / (mySpeechSec + otherSpeechSec)) : null, unit: "" },
    "layer1.mean_sentence_len": { value: r2(mean(sentLens) ?? 0), unit: "слов" },
    "layer1.long_sentences_share": { value: r3(sentLens.filter((n) => n > 22).length / Math.max(1, sentLens.length)), unit: "" },
    "layer1.mtld": { value: (() => { const m = mtld(nonFiller.map((w) => w.norm)); return m == null ? null : r2(m); })(), unit: "" },
    "layer1.interruptions_by_me": { value: o.has_system_track ? count("interruption_by_me") : null, unit: "" },
    "layer1.interruptions_by_other": { value: o.has_system_track ? count("interruption_by_other") : null, unit: "" },
    "layer1.my_speech_sec": { value: r2(mySpeechSec), unit: "с" },
    "layer1.other_speech_sec": { value: o.has_system_track ? r2(otherSpeechSec) : null, unit: "с" },
    "layer1.words_total": { value: nonFiller.length, unit: "" },
    "layer2.pitch_median_hz": { value: L2.pitch_median_hz == null ? null : Math.round(L2.pitch_median_hz), unit: "Гц" },
    "layer2.pitch_range_st": { value: L2.pitch_range_st == null ? null : r2(L2.pitch_range_st), unit: "пт" },
    "layer2.phrase_final_decay_db": { value: L2.phrase_final_decay_db == null ? null : r2(L2.phrase_final_decay_db), unit: "дБ" },
    "layer2.rising_statements_share": { value: L2.rising_statements_share == null ? null : r3(L2.rising_statements_share), unit: "" },
    "layer2.jitter_pct": { value: L2.jitter_pct == null ? null : r2(L2.jitter_pct), unit: "%" },
    "layer2.shimmer_pct": { value: L2.shimmer_pct == null ? null : r2(L2.shimmer_pct), unit: "%" },
    "layer2.start_jitter_ratio": { value: L2.start_jitter_ratio == null ? null : r2(L2.start_jitter_ratio), unit: "" },
    "layer2.loudness_drift_db": { value: L2.loudness_drift_db == null ? null : r2(L2.loudness_drift_db), unit: "дБ" },
    "layer2.loudness_mean_db": { value: L2.loudness_mean_db == null ? null : r2(L2.loudness_mean_db), unit: "дБ" },
  };

  // база
  const baselineReady = !!o.baseline;
  const deltas: BaselineDelta[] = [];
  if (o.baseline) {
    for (const k of BASELINE_KEYS) {
      const st = o.baseline.stats[k];
      const v = raw[k]?.value;
      if (!st || v == null) continue;
      deltas.push({ metric: k, baseline: r2(st.mean), value: v, delta: r2(v - st.mean), z: st.std > 0 ? r2((v - st.mean) / st.std) : null });
    }
  }
  const zOf = (k: string) => deltas.find((d) => d.metric === k)?.z ?? null;

  const mv = (k: string): MetricValue => {
    const { value, unit } = raw[k];
    const [lo, hi] = refFor(k, o.type);
    const better = betterFor(k, lo, hi);
    let status = statusFor(value, lo, hi);
    if (status === "na" && value != null && baselineReady && /jitter_pct|shimmer_pct/.test(k)) {
      const z = zOf(k);
      if (z != null) status = z <= 1 ? "good" : z <= 2 ? "warn" : "bad";
    }
    return { value, unit, ref_low: lo, ref_high: hi, better, status };
  };

  const metrics: Metrics = {
    layer1: {
      wpm: mv("layer1.wpm"),
      articulation_wpm: mv("layer1.articulation_wpm"),
      filled_pauses_total: mv("layer1.filled_pauses_total"),
      filled_pauses_per_min: mv("layer1.filled_pauses_per_min"),
      crutch_words_total: mv("layer1.crutch_words_total"),
      crutch_words_per_min: mv("layer1.crutch_words_per_min"),
      crutch_top: crutchTop,
      structural_pauses_per_min: mv("layer1.structural_pauses_per_min"),
      hesitation_pauses_per_min: mv("layer1.hesitation_pauses_per_min"),
      talk_ratio: mv("layer1.talk_ratio"),
      mean_sentence_len: mv("layer1.mean_sentence_len"),
      long_sentences_share: mv("layer1.long_sentences_share"),
      mtld: mv("layer1.mtld"),
      interruptions_by_me: mv("layer1.interruptions_by_me"),
      interruptions_by_other: mv("layer1.interruptions_by_other"),
      my_speech_sec: mv("layer1.my_speech_sec"),
      other_speech_sec: mv("layer1.other_speech_sec"),
      words_total: mv("layer1.words_total"),
    },
    layer2: {
      pitch_median_hz: mv("layer2.pitch_median_hz"),
      pitch_range_st: mv("layer2.pitch_range_st"),
      phrase_final_decay_db: mv("layer2.phrase_final_decay_db"),
      rising_statements_share: mv("layer2.rising_statements_share"),
      jitter_pct: mv("layer2.jitter_pct"),
      shimmer_pct: mv("layer2.shimmer_pct"),
      start_jitter_ratio: mv("layer2.start_jitter_ratio"),
      loudness_drift_db: mv("layer2.loudness_drift_db"),
      loudness_mean_db: mv("layer2.loudness_mean_db"),
    },
  };

  // оценка §4.6
  const comps: ScoreComponent[] = [];
  let weightSum = 0;
  for (const [k, w] of Object.entries(SCORE_WEIGHTS)) {
    const m = raw[k];
    const [lo, hi] = refFor(k, o.type);
    const usable = m.value != null && (lo != null || hi != null);
    if (!usable) {
      comps.push({ metric: k, weight: 0, penalty: 0 });
      continue;
    }
    weightSum += w;
    let pen = penaltyFor(m.value, lo, hi);
    if (baselineReady) {
      const z = zOf(k);
      if (z != null) {
        const better = betterFor(k, lo, hi);
        const zBad = better === "lower" ? z : better === "higher" ? -z : Math.abs(z);
        pen = 0.5 * pen + 0.5 * Math.min(1, Math.max(0, zBad) / 2);
      }
    }
    comps.push({ metric: k, weight: w, penalty: r3(pen) });
  }
  const scale = weightSum > 0 ? 100 / weightSum : 1;
  for (const c of comps) c.weight = r2(c.weight * scale);
  const overallRaw = Math.round(100 - comps.reduce((s, c) => s + c.weight * c.penalty, 0));
  const overall = Number.isFinite(overallRaw) ? Math.max(0, Math.min(100, overallRaw)) : 0;
  const score: Score = { overall, components: comps, basis: baselineReady ? "baseline" : "reference" };

  const baseline: BaselineComparison = baselineReady
    ? { status: "ready", meetings_used: 3, meetings_needed: 3, deltas }
    : { status: "calibrating", meetings_used: o.calibrating_used ?? 0, meetings_needed: 3, deltas: [] };

  const meaning = o.llm_backend === "none" ? null : buildMeaning(o, scenarioKind, words, sentences, events, otherUtt, metrics, timeline, rng);

  const dataDir = o.data_dir ?? "/Users/me/Library/Application Support/com.remarka.app";
  const report: Report = {
    schema_version: 1,
    meeting: {
      id: o.id,
      started_at: o.started_at,
      duration_sec: D,
      type: o.type,
      type_confidence: o.type_source === "user" ? 1 : scenarioKind === "pitch" ? 0.92 : r2(rng.range(0.6, 0.9)),
      type_source: o.type_source ?? "llm",
      title: o.title,
      has_system_track: o.has_system_track,
      language: "ru",
      training_task_id: o.training_task_id ?? null,
    },
    tracks: {
      mic: { path: `${dataDir}/meetings/${o.id}/mic.wav`, sample_rate: 16000, duration_sec: D },
      system: o.has_system_track ? { path: `${dataDir}/meetings/${o.id}/system.wav`, sample_rate: 16000, duration_sec: D } : null,
    },
    segments: { mic_speech: micSpeech, system_speech: systemSpeech },
    transcript: { words, sentences, other: otherUtt },
    events,
    timeline,
    metrics,
    score,
    baseline,
    meaning,
    engine: {
      version: "0.1.0-mock",
      asr_model: o.asr_model ?? "large-v3-turbo",
      asr_backend: "faster-whisper",
      processing_sec: r2(D * 0.085),
      warnings: o.has_system_track ? [] : ["Системная дорожка не записана: доля речи и перебивания не посчитаны"],
    },
  };
  return report;
}

// ---------------------------------------------------------------------------
// слой смысла
// ---------------------------------------------------------------------------

function findSentence(sentences: Sentence[], text: string): Sentence | null {
  return sentences.find((s) => s.text === text) ?? null;
}

function findWordT(words: Word[], norm: string): number | null {
  const w = words.find((x) => x.norm === norm);
  return w ? w.start : null;
}

function buildMeaning(
  o: GenOptions,
  kind: "pitch" | "generic",
  words: Word[],
  sentences: Sentence[],
  events: SpeechEvent[],
  other: OtherUtterance[],
  metrics: Metrics,
  timeline: Timeline,
  rng: Rng,
): Meaning {
  const backend = o.llm_backend ?? "claude_cli";
  const model = o.llm_model ?? "claude-opus-5";
  const fp = metrics.layer1.filled_pauses_total.value ?? 0;
  const startWin = timeline.wpm.filter((p) => p.t >= 60 && p.t <= 150 && p.v > 0).map((p) => p.v);
  const wpmMax = startWin.length ? Math.max(...startWin) : 0;
  const questions: MeaningQuestion[] = [];
  const qs = other.filter((u) => u.is_question);

  if (kind === "pitch") {
    const clusterN = events.filter((e) => e.kind === "filled_pause" && e.t >= 851 && e.t < 1004).length;
    const comments = [
      "Вопрос был про деньги с одного клиента и стоимость привлечения. Ответ ушёл в размер рынка; цифры по клиенту прозвучали только после повторного вопроса.",
      "Со второго раза — по существу: выручка с магазина, стоимость привлечения, окупаемость. Не хватило когорт: инвестор потом попросил их в письме.",
      "Ответ «мы считаем деньги, а не возим коробки» — тезис, но без сравнения: кто именно конкуренты и чего у них нет. Инвестор ждал названий и одной таблицы.",
      "Про Loop в России — ответа не было: разговор ушёл обратно к продукту. Если не знаешь — так и сказать и пообещать проверить.",
      "Ответ по существу: продавцы и инженеры, вехи — сто магазинов и операционная окупаемость.",
    ];
    const answered: MeaningQuestion["answered"][] = ["off_topic", "partial", "partial", "not_answered", "on_topic"];
    qs.forEach((q, i) => questions.push({ t: q.start, asked: q.text, answered: answered[i] ?? "partial", comment: comments[i] ?? "" }));

    const things: ThreeThing[] = [];
    const a1 = findSentence(sentences, PITCH_ANCHORS.A1);
    const a2 = findSentence(sentences, PITCH_ANCHORS.A2);
    const a0 = findSentence(sentences, PITCH_ANCHORS.A0);
    if (a1) things.push({
      title: "На вопрос про юнит‑экономику ответил про размер рынка",
      why: "Инвестор спросил про деньги с одного клиента и стоимость привлечения — это проверка, считаешь ли ты экономику. Размер рынка на это не отвечает, а цифры у тебя есть: они прозвучали через четыре минуты.",
      quote: a1.text, t: a1.start,
      instead: "«С одного магазина — сорок две тысячи в месяц, привлечение — девяносто, окупается за два с половиной месяца». Про рынок — отдельно, если спросят.",
      metric: null,
    });
    if (a2) things.push({
      title: "Гроздь «э‑э» сразу после первого вопроса",
      why: `Из ${fp} заполненных пауз ${clusterN} пришлись на две с половиной минуты после вопроса про юнит‑экономику. Это не привычка, это неуверенность на конкретном вопросе — и её слышно.`,
      quote: a2.text, t: a2.start,
      instead: "Пауза в полторы секунды вместо «э‑э»: «Хороший вопрос.» — тишина — «С одного клиента мы получаем…».",
      metric: "layer1.filled_pauses_per_min",
    });
    if (a0) things.push({
      title: `Первые полторы минуты — ${wpmMax || 165} слов в минуту`,
      why: `Старт на ${wpmMax || 165} сл/мин при ориентире 110–140: первое впечатление — «нервничает». К третьей минуте темп выровнялся сам, значит это волнение, а не привычка.`,
      quote: a0.text, t: a0.start,
      instead: "Первую фразу — с точкой после названия: «Мы делаем Возвратку.» Пауза. «Это сервис, который…».",
      metric: "layer1.wpm",
    });
    const jargon = [
      { norm: "ltv", term: "LTV к CAC", comment: "Инвестору понятно, но на демо клиенту это стоит расшифровать: «сколько клиент приносит за жизнь против стоимости привлечения»." },
      { norm: "nps", term: "NPS", comment: "Прозвучало без расшифровки. Проще: «семьдесят два процента готовы рекомендовать»." },
    ].map((j) => ({ t: findWordT(words, j.norm), term: j.term, comment: j.comment })).filter((j): j is { t: number; term: string; comment: string } => j.t != null);

    return {
      backend, model,
      meeting_type: { type: "pitch", confidence: 0.92, reason: "Собеседник спрашивает про юнит‑экономику, конкурентов и деньги раунда; спикер говорит про продукт, рынок и команду." },
      structure: { kept: false, comment: "Проблема → продукт → трекшн шло по плану до 14‑й минуты. После вопроса про юнит‑экономику к структуре вернуться не удалось: команда и раунд остались на последние пять минут, а конкуренты прозвучали дважды." },
      questions,
      jargon,
      three_things: things.slice(0, 3),
      dropped_things: 1,
      summary: [
        "## О чём говорили",
        "Питч «Возвратки» — сервиса автоматизации возвратов для интернет‑магазинов. Структура: проблема → продукт → трекшн, затем вопросы инвестора про юнит‑экономику, конкурентов и использование денег раунда.",
        "",
        "## Ключевые тезисы",
        "- Платящие магазины растут, отток за квартал — ноль, весь рост — сарафан и партнёрства",
        "- С одного магазина ~42 тыс. ₽/мес, привлечение ~90 тыс., окупаемость 2,5 месяца",
        "- Раунд: 40 млн ₽ на 18 месяцев, цель — 100 магазинов и операционная окупаемость",
        "",
        "## Вопросы инвестора",
        "- Юнит‑экономика — ответ ушёл в размер рынка, цифры прозвучали после повторного вопроса",
        "- Отличие от конкурентов — «мы считаем деньги, а не возим коробки», без конкретного сравнения; про Loop — без ответа",
        "- На что пойдут деньги — продавцы и интеграции, вехи названы",
      ].join("\n"),
      agreements: [
        { text: "Прислать финансовую модель с разбивкой по когортам", owner: "я", due: "до четверга" },
        { text: "Прислать сравнение с логистами по цене и функциям", owner: "я", due: "до четверга" },
        { text: "Созвон: фонд расскажет, что решили", owner: "инвестор", due: "следующий четверг" },
        { text: "Проверить, работает ли Loop в России через партнёров", owner: "я", due: null },
      ],
    };
  }

  // generic
  const answeredPool: MeaningQuestion["answered"][] = ["on_topic", "partial", "on_topic", "not_answered"];
  qs.forEach((q, i) => questions.push({
    t: q.start, asked: q.text, answered: answeredPool[(i + rng.int(0, 1)) % answeredPool.length],
    comment: i === 0 ? "Ответ по существу, с цифрами, но без сроков." : "Ответ начался с оговорки и ушёл в детали интеграции; на сам вопрос — одной фразой в конце.",
  }));
  const candidates = sentences.filter((s) => s.n_words >= 8 && s.n_words <= 26);
  const crutchy = candidates.filter((s) => words.slice(s.word_from, s.word_to + 1).some((w) => w.kind === "crutch"));
  const longest = [...sentences].sort((a, b) => b.n_words - a.n_words)[0];
  const first = sentences[0];
  const things: ThreeThing[] = [];
  if (crutchy.length) {
    const s = crutchy[Math.floor(crutchy.length / 2)];
    const c = words.slice(s.word_from, s.word_to + 1).find((w) => w.kind === "crutch");
    things.push({
      title: `«${c?.norm ?? "как бы"}» в середине тезиса`,
      why: "Костыль стоит ровно там, где нужна уверенная формулировка. Слушатель считывает это как «сам не уверен».",
      quote: s.text, t: s.start,
      instead: `Та же фраза без «${c?.norm ?? "как бы"}» — и с паузой на этом месте.`,
      metric: "layer1.crutch_words_per_min",
    });
  }
  if (longest && longest.n_words > 20) things.push({
    title: `Предложение на ${longest.n_words} слов`,
    why: "Длиннее 22 слов слушатель теряет начало фразы раньше, чем ты доходишь до её конца.",
    quote: longest.text, t: longest.start,
    instead: "Разбить на два: тезис — точка — пример.",
    metric: "layer1.mean_sentence_len",
  });
  if (first && things.length < 3) things.push({
    title: o.type === "training" ? "Первая фраза без разгона" : "Быстрый старт",
    why: o.type === "training" ? "Задание начато с тезиса, без вступления — это правильно." : "Первые полминуты темп выше среднего по встрече: волнение на старте, потом выравнивается.",
    quote: first.text, t: first.start,
    instead: o.type === "training" ? "Так и держать: тезис, пауза, пример." : "Первую фразу — медленнее, чем хочется, с паузой после первого предложения.",
    metric: "layer1.wpm",
  });
  const typeReason: Record<string, string> = {
    demo: "Показ интерфейса и ответы на вопросы про внедрение и интеграцию.",
    sales: "Обсуждение цены, объёма и рисков; собеседник — покупатель.",
    interview: "Собеседник спрашивает про опыт и мотивацию, спикер отвечает про проекты.",
    standup: "Короткие статусы «вчера/сегодня/блокеры», без вопросов собеседника.",
    one_on_one: "Разговор о спринте и помехах, вопросы про самооценку.",
    lecture: "Длинный монолог с примерами, вопросы из зала.",
    training: "Тренировочное задание, без собеседника.",
    other: "Тип определён по умолчанию.",
    pitch: "Разговор про продукт и деньги.",
  };
  return {
    backend, model,
    meeting_type: { type: o.type, confidence: o.type_source === "user" ? 1 : 0.78, reason: typeReason[o.type] ?? typeReason.other },
    structure: { kept: rng.chance(0.6), comment: rng.chance(0.6) ? "Структура держалась: тезис — пример — вывод, отступлений почти не было." : "Середина ушла в детали интеграции; вывод прозвучал только после вопроса собеседника." },
    questions,
    jargon: [],
    three_things: things.slice(0, 3),
    dropped_things: 0,
    summary: `## О чём говорили\n${o.title ?? "Встреча"}: ${typeReason[o.type] ?? ""}\n\n## Тезисы\n- Показаны цифры за период и план на следующий шаг\n- Основной риск — зависимость от партнёров, закрывается несколькими подрядчиками\n- Договорились о следующем созвоне`,
    agreements: [
      { text: "Прислать расчёт", owner: "я", due: "до пятницы" },
      { text: "Созвониться ещё раз", owner: null, due: "на следующей неделе" },
    ],
  };
}

/** Текст транскрипта одной строкой — для проверки цитат в check-mock */
export function transcriptText(r: Report): string {
  return r.transcript.words.map((w) => w.text).join(" ");
}
