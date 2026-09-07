import type { MeetingStatus, MeetingType } from "../types/contracts";

export const TYPE_LABELS: Record<MeetingType, string> = {
  pitch: "питч инвестору",
  demo: "демо клиенту",
  sales: "продажи",
  interview: "собеседование",
  standup: "стендап",
  lecture: "лекция",
  one_on_one: "1:1",
  training: "тренировка",
  other: "встреча",
};

export const TYPE_ORDER: MeetingType[] = [
  "pitch", "demo", "sales", "interview", "standup", "lecture", "one_on_one", "training", "other",
];

export const STATUS_LABELS: Record<MeetingStatus, string> = {
  recording: "идёт запись",
  recorded: "записано",
  analyzing: "анализ",
  ready: "готово",
  error: "ошибка",
};

export const STAGE_LABELS: Record<string, string> = {
  load: "слушаем запись",
  vad: "ищем речь",
  asr: "распознаём слова",
  align: "расставляем время",
  fillers: "ищем «э‑э» и паузы",
  prosody: "слушаем интонацию",
  metrics: "считаем показатели",
  meaning: "готовим советы",
  summary: "пишем конспект",
  write: "сохраняем",
};

export const APP_LABELS: Record<string, string> = {
  zoom: "Zoom",
  meet: "Google Meet",
  teams: "Microsoft Teams",
  telemost: "Яндекс Телемост",
};

export function typeLabel(t: MeetingType | string | null | undefined): string {
  return (t && TYPE_LABELS[t as MeetingType]) || TYPE_LABELS.other;
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** mm:ss (или h:mm:ss) */
export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m).padStart(2, "0");
  return (h ? `${h}:` : "") + `${mm}:${String(r).padStart(2, "0")}`;
}

/** Длительность словами: «32 мин», «1 ч 05 мин», «62 с» */
export function fmtDur(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return "—";
  if (sec < 120) return `${Math.round(sec)} с`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${String(m % 60).padStart(2, "0")} мин`;
}

/** Число с запятой, без лишних нулей */
export function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  let s = v.toFixed(digits);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s.replace(".", ",").replace(/^-/, "−");
}

export function fmtSigned(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  const s = fmtNum(Math.abs(v), digits);
  if (Math.abs(v) < Math.pow(10, -digits) / 2) return "0";
  return (v > 0 ? "+" : "−") + s;
}

export function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !isFinite(v)) return "—";
  return fmtNum(v * 100, digits) + " %";
}

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const WEEKDAYS_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];

/** Заголовок дня в ленте: «Сегодня», «Вчера», день недели на этой неделе, дальше — «20 августа». */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86400000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  if (diff > 1 && diff < 7) return WEEKDAYS_FULL[d.getDay()];
  const s = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? s : `${s} ${d.getFullYear()}`;
}

/** Время без даты: «14:30» */
export function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtDate(iso: string, withTime = true): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const day = `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  if (!withTime) return day;
  return `${day}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtDateLong(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function monthName(d: Date): string {
  return MONTHS_NOM[d.getMonth()];
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Склонение: plural(3, "встреча", "встречи", "встреч") */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
