/** Блоки экрана разбора: KPI, «Три вещи», просодия, вопросы, конспект, база, таблица метрик. */
import { memo, useMemo } from "react";
import { Link } from "react-router-dom";
import type { Report, TimePoint } from "../types/contracts";
import { fmtDur, fmtNum, fmtPct, fmtSigned, fmtTime, typeLabel } from "../lib/format";
import { METRIC_DEFS, METRIC_BY_KEY, STATUS_TEXT, fmtMetricFull, fmtMetricValue, getMetric, higherIsBetter, metricLabel, refText } from "../lib/metrics";
import { useWidth } from "../lib/useWidth";
import { Delta } from "./Bits";

type Seek = (t: number, andPlay?: boolean) => void;

export function Kpis({ report }: { report: Report }) {
  const m = report.metrics;
  const k = (key: string) => getMetric(m, key);
  const wpm = k("layer1.wpm");
  const fp = k("layer1.filled_pauses_per_min");
  const fpt = k("layer1.filled_pauses_total");
  const tr = k("layer1.talk_ratio");
  const pr = k("layer2.pitch_range_st");
  return (
    <div className="kpis">
      <div className={"kpi " + (wpm?.status ?? "")}>
        <span className="v">
          {wpm?.value != null ? fmtNum(wpm.value, 0) : "—"}
          <small>сл/мин</small>
        </span>
        <span className="k">темп</span>
      </div>
      <div className={"kpi " + (fp?.status ?? "")}>
        <span className="v">
          {fpt?.value ?? "—"}
          <small>{fp?.value != null ? `${fmtNum(fp.value, 1)} в мин` : ""}</small>
        </span>
        <span className="k">заполненных пауз</span>
      </div>
      <div className={"kpi " + (tr?.status ?? "")}>
        <span className="v">{tr?.value != null ? fmtPct(tr.value) : "—"}</span>
        <span className="k">доля своей речи</span>
      </div>
      <div className={"kpi " + (pr?.status ?? "")}>
        <span className="v">
          {pr?.value != null ? fmtNum(pr.value, 1) : "—"}
          <small>пт</small>
        </span>
        <span className="k">диапазон тона</span>
      </div>
      <div className="kpi">
        <span className="v">{fmtTime(report.meeting.duration_sec)}</span>
        <span className="k">{typeLabel(report.meeting.type)}</span>
      </div>
    </div>
  );
}

export function ThreeThings({ report, onSeek }: { report: Report; onSeek: Seek }) {
  const mean = report.meaning;
  if (!mean) {
    const reason = report.engine.warnings.find((w) => w.startsWith("Слой смысла"));
    const needLogin = !!reason && /not logged in|не авторизован|\/login/i.test(reason);
    return (
      <div className="note soft">
        {reason ? (
          <>
            <p>{reason.replace(", отчёт без него", "").replace(/claude CLI:\s*Not logged in.*$/i, "claude CLI не авторизован")}</p>
            <p className="muted">
              {needLogin
                ? "Выполните в терминале команду claude login, затем нажмите «Пересчитать» — появятся три правки с цитатами, конспект и ответы на вопросы."
                : "Проверьте настройки слоя смысла (бэкенд, ключ) и нажмите «Пересчитать»."}
            </p>
          </>
        ) : (
          <p>Слой смысла выключен в настройках — правки с цитатами, конспект и оценка ответов не строились.</p>
        )}
      </div>
    );
  }
  if (!mean.three_things.length) {
    return (
      <div className="note soft">
        <p>Модель не смогла подтвердить ни одну рекомендацию дословной цитатой — такие правки не показываются (риск 04).</p>
      </div>
    );
  }
  return (
    <div className="things">
      {mean.three_things.map((t, i) => (
        <article className="thing" key={i}>
          <div className="thing-n mono">0{i + 1}</div>
          <div className="thing-body">
            <h3 className="h">{t.title}</h3>
            <p className="muted">{t.why}</p>
            <blockquote className="quote">
              <button className="tc" onClick={() => onSeek(t.t, true)} title="Послушать этот момент">
                {fmtTime(t.t)}
              </button>
              <span>«{t.quote}»</span>
            </blockquote>
            <p className="instead">
              <span className="label" style={{ color: "var(--ok)" }}>вместо этого</span>
              {t.instead}
            </p>
            {t.metric && <span className="tag">{metricLabel(t.metric)}</span>}
          </div>
        </article>
      ))}
      {mean.dropped_things > 0 && (
        <p className="hint">
          Ещё {mean.dropped_things} {mean.dropped_things === 1 ? "рекомендация отброшена" : "рекомендации отброшены"}: модель не смогла подтвердить их дословной цитатой.
        </p>
      )}
    </div>
  );
}

/** Маленький график по времени (SVG): линия + базовая линия, клик → seek */
export const MiniSeries = memo(function MiniSeries({
  points, duration, time, onSeek, unit, baseline, digits = 1, color = "var(--ink-2)",
}: {
  points: TimePoint[];
  duration: number;
  time: number;
  onSeek: Seek;
  unit: string;
  baseline?: number;
  digits?: number;
  color?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(360);
  const W = Math.max(200, width);
  const H = 84;
  const geo = useMemo(() => {
    if (!points.length) return null;
    const vs = points.map((p) => p.v);
    let lo = Math.min(...vs, baseline ?? Infinity);
    let hi = Math.max(...vs, baseline ?? -Infinity);
    if (hi - lo < 1) {
      lo -= 0.5;
      hi += 0.5;
    }
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;
    const x = (t: number) => (t / duration) * W;
    const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo)) * (H - 24);
    const d = "M" + points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" L");
    return { x, y, d, lo, hi };
  }, [points, duration, W, baseline]);
  if (!geo) return <div className="hint">нет данных</div>;
  return (
    <div ref={ref} className="mini">
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ display: "block", cursor: "pointer" }}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * duration);
        }}
      >
        {baseline != null && <line x1={0} y1={geo.y(baseline)} x2={W} y2={geo.y(baseline)} stroke="var(--rule)" strokeDasharray="2 4" />}
        <path d={geo.d} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        <line x1={geo.x(time)} y1={0} x2={geo.x(time)} y2={H - 14} stroke="var(--ink)" strokeWidth={1} />
        <line x1={0} y1={H - 14} x2={W} y2={H - 14} stroke="var(--rule)" />
        <text x={2} y={H - 3} fill="var(--ink-3)" fontFamily="var(--f-mono)" fontSize="9">
          {fmtNum(geo.lo, digits)} {unit}
        </text>
        <text x={W - 2} y={H - 3} textAnchor="end" fill="var(--ink-3)" fontFamily="var(--f-mono)" fontSize="9">
          {fmtNum(geo.hi, digits)} {unit}
        </text>
      </svg>
    </div>
  );
});

export function Prosody({ report, time, onSeek }: { report: Report; time: number; onSeek: Seek }) {
  const l2 = report.metrics.layer2;
  const D = report.meeting.duration_sec;
  const rows: { key: string; hint: string }[] = [
    { key: "layer2.pitch_range_st", hint: "меньше 4 пт — монотонно" },
    { key: "layer2.phrase_final_decay_db", hint: "«съедание» окончаний" },
    { key: "layer2.rising_statements_share", hint: "утверждение звучит как вопрос" },
    { key: "layer2.loudness_drift_db", hint: "«сдулся» ко второй половине" },
  ];
  return (
    <div className="prosody">
      <div className="pro-nums">
        {rows.map(({ key, hint }) => {
          const mv = getMetric(report.metrics, key)!;
          return (
            <div key={key} className={"kpi " + mv.status}>
              <span className="v">{fmtMetricValue(key, mv.value)}<small>{METRIC_BY_KEY[key].fmt ? "" : METRIC_BY_KEY[key].unit}</small></span>
              <span className="k">{METRIC_BY_KEY[key].short}</span>
              <span className="hint">{hint} · ориентир {refText(key, mv)}</span>
            </div>
          );
        })}
      </div>
      <div className="grid-2 pro-charts">
        <div>
          <span className="label">Громкость моей речи, дБ</span>
          <MiniSeries points={report.timeline.loudness_db} duration={D} time={time} onSeek={onSeek} unit="дБ" baseline={l2.loudness_mean_db.value ?? undefined} digits={0} />
        </div>
        <div>
          <span className="label">Тон относительно медианы, полутоны</span>
          <MiniSeries points={report.timeline.pitch_semitones} duration={D} time={time} onSeek={onSeek} unit="пт" baseline={0} digits={1} color="var(--signal)" />
        </div>
      </div>
      <p className="hint">
        Медиана тона {l2.pitch_median_hz.value != null ? `${fmtNum(l2.pitch_median_hz.value, 0)} Гц` : "—"} · джиттер {fmtNum(l2.jitter_pct.value, 2)} % · шиммер {fmtNum(l2.shimmer_pct.value, 2)} %
        {l2.start_jitter_ratio.value != null && ` · джиттер старта ×${fmtNum(l2.start_jitter_ratio.value, 2)}`}. Джиттер и шиммер сравниваются только с твоей базой.
      </p>
    </div>
  );
}

const ANSWERED: Record<string, { text: string; cls: string }> = {
  on_topic: { text: "по теме", cls: "ok" },
  partial: { text: "частично", cls: "warn" },
  off_topic: { text: "мимо", cls: "signal" },
  not_answered: { text: "без ответа", cls: "signal" },
};

export function Questions({ report, onSeek }: { report: Report; onSeek: Seek }) {
  const mean = report.meaning;
  const qs = mean?.questions ?? [];
  if (!qs.length) {
    // без слоя смысла показываем вопросы, найденные движком по системной дорожке
    const evq = report.events.filter((e) => e.kind === "question_from_other");
    if (evq.length) {
      return (
        <div className="qa">
          {evq.map((e, i) => {
            const utt = report.transcript.other.find((o) => Math.abs(o.start - e.t) < 0.35) ?? null;
            return (
              <div key={i} className="q">
                <div className="q-head">
                  <button className="tc" onClick={() => onSeek(e.t, true)}>{fmtTime(e.t)}</button>
                  <span className="tag">вопрос собеседника</span>
                </div>
                <p className="q-asked">{utt?.text ?? e.label}</p>
              </div>
            );
          })}
          <p className="hint">Оценка ответов (по теме / частично / ушёл в сторону) появится вместе со слоем смысла.</p>
        </div>
      );
    }
    return (
      <p className="hint">
        {report.meeting.has_system_track ? "Вопросов собеседника не найдено." : "Без системной дорожки вопросы собеседника не распознаются."}
      </p>
    );
  }
  return (
    <div className="qa">
      {qs.map((q, i) => (
        <div key={i} className="q">
          <div className="q-head">
            <button className="tc" onClick={() => onSeek(q.t, true)}>{fmtTime(q.t)}</button>
            <span className={"tag " + ANSWERED[q.answered]?.cls}>{ANSWERED[q.answered]?.text ?? q.answered}</span>
          </div>
          <p className="q-asked">{q.asked}</p>
          <p className="muted q-comment">{q.comment}</p>
        </div>
      ))}
      {mean && mean.jargon.length > 0 && (
        <div className="jargon">
          <span className="label">Жаргон без расшифровки</span>
          {mean.jargon.map((j, i) => (
            <p key={i}>
              <button className="tc" onClick={() => onSeek(j.t, true)}>{fmtTime(j.t)}</button> <strong>{j.term}</strong> — <span className="muted">{j.comment}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function BaselineBlock({ report }: { report: Report }) {
  const b = report.baseline;
  if (!b) return <p className="hint">Сравнение с базой недоступно.</p>;
  if (b.status === "calibrating") {
    return (
      <div className="note soft">
        <p>
          <strong>Калибровка: {b.meetings_used} из {b.meetings_needed}.</strong> Первые три встречи собирают твой личный базовый уровень; до этого оценка — по ориентирам для типа «{typeLabel(report.meeting.type)}».
        </p>
      </div>
    );
  }
  const rows = b.deltas.filter((d) => METRIC_BY_KEY[d.metric]);
  return (
    <div className="tablewrap">
      <table className="t">
        <thead>
          <tr>
            <th>Метрика</th>
            <th className="num">База</th>
            <th className="num">Сейчас</th>
            <th className="num">Дельта</th>
            <th className="num">z</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const def = METRIC_BY_KEY[d.metric];
            const mv = getMetric(report.metrics, d.metric);
            const hib = higherIsBetter(mv);
            return (
              <tr key={d.metric}>
                <td className="metric">{def.label}</td>
                <td className="num">{fmtMetricValue(d.metric, d.baseline)}</td>
                <td className="num">{fmtMetricValue(d.metric, d.value)}</td>
                <td className="num">
                  {def.fmt ? (
                    <Delta v={d.delta * 100} digits={0} goodWhenHigher={hib} suffix=" п.п." />
                  ) : (
                    <Delta v={d.delta} digits={def.digits} goodWhenHigher={hib} />
                  )}
                </td>
                <td className="num faint">{d.z == null ? "—" : fmtSigned(d.z, 1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint" style={{ marginTop: 8 }}>
        База — среднее по первым трём встречам ({b.meetings_used}); z — отклонение в стандартных отклонениях. Оценка {report.score.overall} считалась относительно базы.
      </p>
    </div>
  );
}

export function MetricsTable({ report }: { report: Report }) {
  const groups: { g: "layer1" | "layer2"; title: string }[] = [
    { g: "layer1", title: "Слой 1 · из транскрипта" },
    { g: "layer2", title: "Слой 2 · из сигнала" },
  ];
  const top = report.metrics.layer1.crutch_top;
  return (
    <div className="mtable">
      <table className="t">
        <thead>
          <tr>
            <th>Метрика</th>
            <th className="num">Значение</th>
            <th className="num">Ориентир</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(({ g, title }) => (
            <GroupRows key={g} title={title} report={report} keys={METRIC_DEFS.filter((d) => d.group === g).map((d) => d.key)} />
          ))}
        </tbody>
      </table>
      {top.length > 0 && (
        <div className="crutch-top">
          <span className="label">Слова‑костыли</span>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            {top.map((c) => (
              <span key={c.word} className="tag">
                {c.word} · {c.count}
              </span>
            ))}
          </div>
        </div>
      )}
      <p className="hint" style={{ marginTop: 10 }}>
        Оценка: {report.score.overall} из 100, {report.score.basis === "baseline" ? "относительно твоей базы" : "по ориентирам типа встречи"}. Полный расчёт — в <Link to="/progress">прогрессе</Link>.
      </p>
    </div>
  );
}

function GroupRows({ title, report, keys }: { title: string; report: Report; keys: string[] }) {
  return (
    <>
      <tr className="group">
        <td colSpan={3}>{title}</td>
      </tr>
      {keys.map((key) => {
        const def = METRIC_BY_KEY[key];
        const mv = getMetric(report.metrics, key);
        if (!mv) return null;
        return (
          <tr key={key} title={`${def.how} · ${STATUS_TEXT[mv.status]}`}>
            <td className="metric">
              {def.label}
              <span className="how">{def.how}</span>
            </td>
            <td className={"num " + (mv.status === "na" ? "faint" : mv.status)}>
              <span className={"sdot " + mv.status} aria-label={STATUS_TEXT[mv.status]} />
              {fmtMetricFull(key, mv.value)}
            </td>
            <td className="num faint">{refText(key, mv)}</td>
          </tr>
        );
      })}
    </>
  );
}

export function ScoreBreakdown({ report }: { report: Report }) {
  const comps = report.score.components.filter((c) => c.weight > 0);
  return (
    <div className="tablewrap">
      <table className="t">
        <thead>
          <tr>
            <th>Компонент</th>
            <th className="num">Вес</th>
            <th className="num">Штраф</th>
            <th className="num">Снято</th>
          </tr>
        </thead>
        <tbody>
          {comps.map((c) => (
            <tr key={c.metric}>
              <td className="metric">{metricLabel(c.metric)}</td>
              <td className="num">{fmtNum(c.weight, 0)}</td>
              <td className={"num " + (c.penalty > 0.5 ? "bad" : c.penalty > 0 ? "warn" : "good")}>{fmtPct(c.penalty)}</td>
              <td className="num">−{fmtNum(c.weight * c.penalty, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function durationLabel(sec: number): string {
  return fmtDur(sec);
}
