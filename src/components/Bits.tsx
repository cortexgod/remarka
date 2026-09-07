import type { MeetingType, MetricValue } from "../types/contracts";
import { STATUS_TEXT } from "../lib/metrics";
import { fmtSigned, typeLabel } from "../lib/format";

export function StatusTag({ status }: { status: MetricValue["status"] }) {
  const cls = status === "good" ? "ok" : status === "warn" ? "warn" : status === "bad" ? "signal" : "";
  return <span className={"tag " + cls}>{STATUS_TEXT[status]}</span>;
}

export function TypeTag({ type, source }: { type: MeetingType; source?: "llm" | "user" | "default" }) {
  return (
    <span className="tag" title={source === "llm" ? "Тип определён моделью" : source === "user" ? "Тип задан вручную" : "Тип по умолчанию"}>
      {typeLabel(type)}
      {source === "llm" ? " · ai" : ""}
    </span>
  );
}

export function Delta({ v, digits = 0, goodWhenHigher = true, suffix = "" }: { v: number | null | undefined; digits?: number; goodWhenHigher?: boolean | null; suffix?: string }) {
  if (v == null || !isFinite(v)) return <span className="num faint">—</span>;
  const eps = Math.pow(10, -digits) / 2;
  const cls = Math.abs(v) < eps || goodWhenHigher === null ? "faint" : (v > 0) === goodWhenHigher ? "good" : "bad";
  return (
    <span className={"num " + cls}>
      {fmtSigned(v, digits)}
      {suffix}
    </span>
  );
}

/** Индикатор уровня микрофона: дБFS −60…0 */
export function LevelMeter({ db, label }: { db: number | null; label?: string }) {
  const pct = db == null ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  return (
    <div className="level">
      {label && <span className="label">{label}</span>}
      <div className="meter">
        <div className={"fill" + (db != null && db > -6 ? " hot" : "")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Полоска темпа: оценка wpm против ориентира */
export function TempoBar({ wpm, lo = 100, hi = 130, min = 60, max = 200 }: { wpm: number | null; lo?: number; hi?: number; min?: number; max?: number }) {
  const p = (v: number) => `${Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100))}%`;
  return (
    <div className="tempo-bar" title={wpm == null ? "темп ещё не оценён" : `${wpm} сл/мин`}>
      <div className="band" style={{ left: p(lo), width: `calc(${p(hi)} - ${p(lo)})` }} />
      {wpm != null && <div className="pin" style={{ left: p(wpm) }} />}
    </div>
  );
}

export function Spinner({ text = "Загрузка…" }: { text?: string }) {
  return <div className="faint mono spinner">{text}</div>;
}
