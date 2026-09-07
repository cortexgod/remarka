import { memo, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ProgressSeriesPoint } from "../types/contracts";
import { fmtDate, typeLabel } from "../lib/format";
import { useWidth } from "../lib/useWidth";

interface Props {
  points: ProgressSeriesPoint[];
  format: (v: number) => string;
  baseline?: number | null;
  refLow?: number | null;
  refHigh?: number | null;
  height?: number;
  color?: string;
}

/** График метрики по встречам (SVG): точки по порядку, база пунктиром, клик → разбор. */
export const LineChart = memo(function LineChart({ points, format, baseline, refLow, refHigh, height = 120, color = "var(--signal)" }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>(400);
  const nav = useNavigate();
  const [hover, setHover] = useState<number | null>(null);
  const W = Math.max(200, width);
  const H = height;
  const padL = 6;
  const padR = 6;
  const geo = useMemo(() => {
    if (!points.length) return null;
    const vs = points.map((p) => p.value);
    const extra = [baseline, refLow, refHigh].filter((v): v is number => v != null);
    let lo = Math.min(...vs, ...extra);
    let hi = Math.max(...vs, ...extra);
    if (hi - lo < 1e-6) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.15;
    lo -= pad;
    hi += pad;
    const n = points.length;
    const x = (i: number) => (n === 1 ? W / 2 : padL + (i / (n - 1)) * (W - padL - padR));
    const y = (v: number) => 10 + (1 - (v - lo) / (hi - lo)) * (H - 34);
    const d = "M" + points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" L");
    return { x, y, d, lo, hi };
  }, [points, W, H, baseline, refLow, refHigh]);
  if (!geo) return <div ref={ref} className="hint" style={{ padding: "16px 0" }}>Пока нет данных</div>;
  const hp = hover != null ? points[hover] : null;
  return (
    <div ref={ref} className="linechart">
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block" }} onMouseLeave={() => setHover(null)}>
        {refLow != null && refHigh != null && <rect x={0} y={geo.y(refHigh)} width={W} height={Math.max(1, geo.y(refLow) - geo.y(refHigh))} fill="var(--surface-2)" />}
        {refLow != null && refHigh == null && <line x1={0} y1={geo.y(refLow)} x2={W} y2={geo.y(refLow)} stroke="var(--rule)" strokeDasharray="1 3" />}
        {refHigh != null && refLow == null && <line x1={0} y1={geo.y(refHigh)} x2={W} y2={geo.y(refHigh)} stroke="var(--rule)" strokeDasharray="1 3" />}
        {baseline != null && <line x1={0} y1={geo.y(baseline)} x2={W} y2={geo.y(baseline)} stroke="var(--ink-3)" strokeDasharray="3 4" />}
        <line x1={0} y1={H - 22} x2={W} y2={H - 22} stroke="var(--rule)" />
        <path d={geo.d} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {points.map((p, i) => (
          <g key={p.meeting_id + i} onMouseEnter={() => setHover(i)} onClick={() => nav(`/meeting/${p.meeting_id}`)} style={{ cursor: "pointer" }}>
            <circle cx={geo.x(i)} cy={geo.y(p.value)} r={9} fill="transparent" />
            <circle cx={geo.x(i)} cy={geo.y(p.value)} r={hover === i ? 4 : 2.6} fill={p.meeting_type === "training" ? "var(--surface)" : color} stroke={color} strokeWidth={1.4} />
          </g>
        ))}
        {points.map((p, i) =>
          i === 0 || i === points.length - 1 || (points.length > 6 && i % Math.ceil(points.length / 4) === 0) ? (
            <text key={"l" + i} x={i === points.length - 1 ? Math.min(geo.x(i), W - 2) : geo.x(i)} y={H - 8} textAnchor={i === points.length - 1 ? "end" : i === 0 ? "start" : "middle"} fill="var(--ink-3)" fontFamily="var(--f-mono)" fontSize="9">
              {fmtDate(p.started_at, false)}
            </text>
          ) : null,
        )}
        {hp && hover != null && (
          <g pointerEvents="none">
            <rect x={Math.min(Math.max(2, geo.x(hover) - 70), W - 142)} y={2} width={140} height={16} fill="var(--surface)" stroke="var(--rule)" />
            <text x={Math.min(Math.max(2, geo.x(hover) - 70), W - 142) + 4} y={13.5} fill="var(--ink)" fontFamily="var(--f-mono)" fontSize="9.5">
              {fmtDate(hp.started_at, false)} · {format(hp.value)} · {typeLabel(hp.meeting_type)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
});
