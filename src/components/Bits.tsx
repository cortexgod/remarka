import type { MeetingType, MetricValue } from "../types/contracts";
import { STATUS_TEXT } from "../lib/metrics";
import { fmtSigned, typeLabel } from "../lib/format";

export function StatusTag({ status }: { status: MetricValue["status"] }) {
  const cls = status === "good" ? "ok" : status === "warn" ? "warn" : status === "bad" ? "signal" : "";
  return <span className={"tag " + cls}>{STATUS_TEXT[status]}</span>;
}

export function TypeTag({ type, source }: { type: MeetingType; source?: "llm" | "user" | "default" }) {
  return (
    <span className="tag" title={source === "llm" ? "Тип определён по разговору" : source === "user" ? "Тип выбран вручную" : "Тип не определён"}>
      {typeLabel(type)}
    </span>
  );
}

/** Оттенок оценки: ≥75 — хорошо, ≥55 — на грани, ниже — стоит поправить */
export function scoreTone(v: number | null | undefined): "good" | "warn" | "bad" | "na" {
  if (v == null || !isFinite(v)) return "na";
  return v >= 75 ? "good" : v >= 55 ? "warn" : "bad";
}

/** Кольцо оценки 0–100 с числом внутри */
export function ScoreRing({ value, size = 52, stroke = 4.5, text, tone }: { value: number | null | undefined; size?: number; stroke?: number; text?: string; tone?: "good" | "warn" | "bad" | "na" }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className={"ring " + (tone ?? scoreTone(value))} style={{ width: size, height: size }} aria-label={value == null ? "оценки нет" : `оценка ${value} из 100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--ring-track)" strokeWidth={stroke} />
        {value != null && (
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${(c * v) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="ring-v" style={{ fontSize: Math.round(size * 0.36) }}>{text ?? value ?? "—"}</span>
    </div>
  );
}

/** Иллюстрация пустого состояния: две реплики с волной голоса */
export function EmptyArt() {
  return (
    <svg className="empty-art" width="164" height="92" viewBox="0 0 164 92" aria-hidden="true">
      <path d="M22 14h60a12 12 0 0 1 12 12v14a12 12 0 0 1-12 12H40l-10 11V52a12 12 0 0 1-8-11.3V26a12 12 0 0 1 12-12z" fill="var(--bg-3)" />
      <g stroke="var(--ink-3)" strokeWidth="3.5" strokeLinecap="round">
        <path d="M36 30v6M48 25v16M60 28v10M72 26v14" />
      </g>
      <path d="M82 40h48a11 11 0 0 1 11 11v12a11 11 0 0 1-11 11H97l-9 9V74a11 11 0 0 1-8-10.6V51a11 11 0 0 1 11-11z" fill="var(--accent)" />
      <g stroke="#fff" strokeWidth="3.5" strokeLinecap="round">
        <path d="M95 54v6M106 48v18M117 52v10M128 55v4" />
      </g>
    </svg>
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

/** Живой график темпа за последние ~60 с: полоса ориентира и линия оценок */
export function Sparkline({ values, lo, hi, min = 60, max = 200 }: { values: number[]; lo: number; hi: number; min?: number; max?: number }) {
  const W = 600;
  const H = 56;
  const y = (v: number) => H - ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * H;
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * W},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y={y(hi)} width={W} height={Math.max(1, y(lo) - y(hi))} fill="var(--ok)" opacity="0.18" />
      {values.length > 1 && <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
    </svg>
  );
}
