import { memo, useMemo, useState, type MouseEvent } from "react";
import type { Report } from "../types/contracts";
import { fmtTime } from "../lib/format";
import { useWidth } from "../lib/useWidth";

interface Props {
  report: Report;
  time: number;
  onSeek: (t: number) => void;
}

/**
 * Таймлайн встречи (SVG): линия темпа с заливкой, ориентир, тики заполненных пауз,
 * полоски «говорит собеседник», отметки вопросов, курсор. Клик — переход к моменту.
 */
export const Timeline = memo(function Timeline({ report, time, onSeek }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>(760);
  const [hover, setHover] = useState<number | null>(null);
  const D = report.meeting.duration_sec;
  const W = Math.max(320, width);
  const H = 172;
  const top = 12;
  const plotH = 78;
  const yBase = top + plotH; // 90
  const tickY = yBase + 8;
  const otherY = yBase + 24;
  const axisY = yBase + 40;

  const geo = useMemo(() => {
    const wpm = report.timeline.wpm;
    const maxV = Math.max(170, ...wpm.map((p) => p.v)) * 1.05;
    const x = (t: number) => (t / D) * W;
    const y = (v: number) => top + plotH - (v / maxV) * plotH;
    const pts = wpm.map((p) => [x(p.t), y(p.v)] as const);
    const line = pts.length ? "M" + pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" L") : "";
    const area = pts.length ? `M${pts[0][0].toFixed(1)},${yBase} L` + pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" L") + ` L${pts[pts.length - 1][0].toFixed(1)},${yBase} Z` : "";
    const m = report.metrics.layer1.wpm;
    const refLo = m.ref_low != null ? y(m.ref_low) : null;
    const refHi = m.ref_high != null ? y(m.ref_high) : null;
    const fillers = report.events.filter((e) => e.kind === "filled_pause").map((e) => x(e.t));
    const hes = report.events.filter((e) => e.kind === "hesitation_pause").map((e) => x(e.t));
    const other = report.timeline.other_speaking.map((s) => [x(s.start), Math.max(2, x(s.end) - x(s.start))] as const);
    const questions = report.events.filter((e) => e.kind === "question_from_other").map((e) => ({ x: x(e.t), label: e.label }));
    const bursts = report.events.filter((e) => e.kind === "fast_burst").map((e) => [x(e.t), Math.max(2, x(e.end) - x(e.t))] as const);
    // подписи оси: шаг 2/4/8 минут
    const step = D > 3000 ? 600 : D > 1500 ? 480 : D > 600 ? 240 : D > 180 ? 60 : 15;
    const ticks: number[] = [];
    for (let t = 0; t <= D; t += step) ticks.push(t);
    return { x, y, line, area, refLo, refHi, fillers, hes, other, questions, bursts, ticks, maxV, m };
  }, [report, W, D]);

  const tAt = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = Math.max(0, Math.min(r.width, e.clientX - r.left));
    return (px / r.width) * D;
  };
  const hoverWpm = hover == null ? null : (report.timeline.wpm.find((p) => Math.abs(p.t - hover) <= 2.5)?.v ?? null);

  return (
    <div className="timeline" ref={ref}>
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Таймлайн встречи: темп речи, заполненные паузы, реплики собеседника"
        onClick={(e) => onSeek(tAt(e))}
        onMouseMove={(e) => setHover(tAt(e))}
        onMouseLeave={() => setHover(null)}
        style={{ cursor: "pointer", display: "block" }}
      >
        {/* всплески темпа */}
        {geo.bursts.map(([bx, bw], i) => (
          <rect key={"b" + i} x={bx} y={top} width={bw} height={plotH} fill="var(--signal-wash)" />
        ))}
        {/* ориентир */}
        {geo.refHi != null && <line x1={0} y1={geo.refHi} x2={W} y2={geo.refHi} stroke="var(--rule-soft)" strokeDasharray="2 4" />}
        {geo.refLo != null && <line x1={0} y1={geo.refLo} x2={W} y2={geo.refLo} stroke="var(--rule-soft)" strokeDasharray="2 4" />}
        {geo.refHi != null && geo.m.ref_high != null && (
          <text x={2} y={geo.refHi - 3} fill="var(--ink-3)" fontFamily="var(--f-mono)" fontSize="9">
            {geo.m.ref_high}
          </text>
        )}
        {geo.refLo != null && geo.m.ref_low != null && (
          <text x={2} y={geo.refLo - 3} fill="var(--ink-3)" fontFamily="var(--f-mono)" fontSize="9">
            {geo.m.ref_low}
          </text>
        )}
        <line x1={0} y1={yBase} x2={W} y2={yBase} stroke="var(--rule)" />
        {/* темп */}
        <path d={geo.area} fill="var(--signal-wash)" />
        <path d={geo.line} fill="none" stroke="var(--signal)" strokeWidth={1.6} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {/* хезитации — бледные точки под линией */}
        {geo.hes.map((hx, i) => (
          <rect key={"h" + i} x={hx - 0.5} y={tickY + 10} width={1} height={3} fill="var(--rule)" />
        ))}
        {/* заполненные паузы */}
        {geo.fillers.map((fx, i) => (
          <rect key={"f" + i} x={fx - 1} y={tickY} width={2} height={9} fill="var(--ink-3)" />
        ))}
        {/* собеседник */}
        {geo.other.map(([ox, ow], i) => (
          <rect key={"o" + i} x={ox} y={otherY} width={ow} height={5} fill="var(--signal)" />
        ))}
        {geo.questions.map((q, i) => (
          <g key={"q" + i}>
            <circle cx={q.x} cy={otherY + 2.5} r={6} fill="var(--surface)" stroke="var(--signal)" />
            <text x={q.x} y={otherY + 5.5} textAnchor="middle" fill="var(--signal-ink)" fontFamily="var(--f-mono)" fontSize="8.5" fontWeight="500">
              ?
            </text>
          </g>
        ))}
        {/* ось */}
        <line x1={0} y1={axisY} x2={W} y2={axisY} stroke="var(--rule)" />
        {geo.ticks.map((t) => (
          <g key={t}>
            <line x1={geo.x(t)} y1={axisY} x2={geo.x(t)} y2={axisY + 4} stroke="var(--rule)" />
            <text x={Math.min(geo.x(t) + 3, W - 34)} y={axisY + 15} fill="var(--ink-3)" fontFamily="var(--f-mono)" fontSize="9">
              {fmtTime(t)}
            </text>
          </g>
        ))}
        {/* ховер */}
        {hover != null && (
          <g pointerEvents="none">
            <line x1={geo.x(hover)} y1={top} x2={geo.x(hover)} y2={axisY} stroke="var(--ink-3)" strokeDasharray="2 3" />
            <rect x={Math.min(geo.x(hover) + 6, W - 96)} y={top} width={90} height={16} fill="var(--surface)" stroke="var(--rule)" />
            <text x={Math.min(geo.x(hover) + 10, W - 92)} y={top + 11.5} fill="var(--ink)" fontFamily="var(--f-mono)" fontSize="9.5">
              {fmtTime(hover)} · {hoverWpm ?? "—"} сл/мин
            </text>
          </g>
        )}
        {/* курсор воспроизведения */}
        <g pointerEvents="none">
          <line x1={geo.x(time)} y1={top - 4} x2={geo.x(time)} y2={axisY} stroke="var(--ink)" strokeWidth={1.2} />
          <polygon points={`${geo.x(time) - 4},${top - 8} ${geo.x(time) + 4},${top - 8} ${geo.x(time)},${top - 2}`} fill="var(--ink)" />
        </g>
      </svg>
      <div className="legend">
        <span>
          <i className="swatch line" style={{ background: "var(--signal)" }} />
          темп речи
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--signal-wash)", border: "1px solid var(--rule)" }} />
          ориентир {geo.m.ref_low ?? "—"}–{geo.m.ref_high ?? "—"}
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--ink-3)", width: 2 }} />
          заполненная пауза
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--signal)", height: 5 }} />
          говорит собеседник
        </span>
        <span>
          <i className="swatch" style={{ border: "1px solid var(--signal)", borderRadius: "50%", background: "var(--surface)" }} />
          вопрос
        </span>
      </div>
    </div>
  );
});
