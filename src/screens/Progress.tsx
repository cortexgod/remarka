import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Baseline, PatternsResult, ProgressData } from "../types/contracts";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { fmtDate, fmtNum, monthName, plural } from "../lib/format";
import { METRIC_BY_KEY, PROGRESS_KEYS, fmtMetricValue, metricLabel } from "../lib/metrics";
import { Markdown } from "../lib/markdown";
import { LineChart } from "../components/LineChart";
import { Delta } from "../components/Bits";

export default function Progress() {
  const { run, meetings } = useStore();
  const [data, setData] = useState<ProgressData | null>(null);
  const [patterns, setPatterns] = useState<PatternsResult | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.getProgress().then(setData).catch((e) => setErr((e as Error).message));
    api.getPatterns().then(setPatterns).catch(() => setPatterns(null));
    api.getBaseline().then(setBaseline).catch(() => setBaseline(null));
  }, [meetings.length]);

  const refresh = async () => {
    setBusy(true);
    const p = await run(api.refreshPatterns(), "Инсайты обновлены");
    if (p) setPatterns(p);
    setBusy(false);
  };

  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthRows = useMemo(() => {
    if (!data) return [];
    return ["score", ...PROGRESS_KEYS].map((k) => ({ key: k, a: data.prev_month[k] ?? null, b: data.this_month[k] ?? null }));
  }, [data]);
  const titleFor = (id: string) => {
    const m = meetings.find((x) => x.id === id);
    return m ? `${m.title ?? m.meeting_type} · ${fmtDate(m.started_at, false)}` : id.slice(0, 8);
  };

  return (
    <div className="page">
      <p className="eyebrow">Прогресс</p>
      <h1 className="title">Как меняется речь</h1>
      <p className="lede">Метрики по встречам, серия, сравнение месяцев и то, что видно только по всем встречам сразу.</p>
      {err && <div className="note"><p>{err}</p></div>}
      {data && (
        <dl className="facts" style={{ marginBottom: 28 }}>
          <div>
            <dt>Встреч</dt>
            <dd>{data.meetings_total}</dd>
          </div>
          <div>
            <dt>Серия</dt>
            <dd>{data.streak_days} {plural(data.streak_days, "рабочий день", "рабочих дня", "рабочих дней")} подряд</dd>
          </div>
          <div>
            <dt>База</dt>
            <dd>{data.baseline?.status === "ready" ? "готова, сравниваем с тобой" : `калибровка ${data.baseline?.meetings_used ?? 0} из ${data.baseline?.meetings_needed ?? 3}`}</dd>
          </div>
          <div>
            <dt>Оценка за {monthName(now).toLowerCase()}</dt>
            <dd>
              {data.this_month.score != null ? fmtNum(data.this_month.score, 0) : "—"}{" "}
              {data.this_month.score != null && data.prev_month.score != null && <Delta v={data.this_month.score - data.prev_month.score} digits={0} />}
            </dd>
          </div>
        </dl>
      )}

      {data && (
        <div className="section" style={{ paddingTop: 0 }}>
          <div className="section-head">
            <h2 className="h">Оценка по встречам</h2>
            <span className="aside">точка — разбор · пустая точка — тренировка</span>
          </div>
          <LineChart points={data.score} format={(v) => fmtNum(v, 0)} height={150} />
        </div>
      )}

      {data && (
        <div className="section">
          <div className="section-head">
            <h2 className="h">Метрики</h2>
            <span className="aside">пунктир — твоя база</span>
          </div>
          <div className="charts">
            {PROGRESS_KEYS.map((k) => {
              const pts = data.series[k] ?? [];
              const def = METRIC_BY_KEY[k];
              const last = pts[pts.length - 1];
              return (
                <div key={k} className="chart-card">
                  <div className="row between">
                    <span className="label">{def.label}</span>
                    <span className="mono">{last ? fmtMetricValue(k, last.value) : "—"}{def.fmt ? "" : ` ${def.unit}`}</span>
                  </div>
                  <LineChart points={pts} format={(v) => fmtMetricValue(k, v)} baseline={baseline?.stats[k]?.mean ?? null} color={def.group === "layer2" ? "var(--ink-2)" : "var(--signal)"} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {data && (
        <div className="section">
          <div className="section-head">
            <h2 className="h">Месяцы</h2>
            <span className="aside">{monthName(prev)} → {monthName(now)}</span>
          </div>
          <div className="tablewrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Метрика</th>
                  <th className="num">{monthName(prev)}</th>
                  <th className="num">{monthName(now)}</th>
                  <th className="num">Дельта</th>
                </tr>
              </thead>
              <tbody>
                {monthRows.map((r) => {
                  const def = METRIC_BY_KEY[r.key];
                  const f = (v: number | null) => (v == null ? "—" : r.key === "score" ? fmtNum(v, 0) : fmtMetricValue(r.key, v));
                  const hib = r.key === "score" ? true : r.key.includes("talk_ratio") || r.key.includes("wpm") ? null : /pitch_range|structural/.test(r.key) ? true : false;
                  return (
                    <tr key={r.key}>
                      <td className="metric">{r.key === "score" ? "Оценка" : def.label}</td>
                      <td className="num">{f(r.a)}</td>
                      <td className="num">{f(r.b)}</td>
                      <td className="num">{r.a != null && r.b != null ? (def?.fmt ? <Delta v={(r.b - r.a) * 100} digits={0} goodWhenHigher={hib} suffix=" п.п." /> : <Delta v={r.b - r.a} digits={def?.digits ?? 0} goodWhenHigher={hib} />) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <h2 className="h"><span className="num">Между встречами</span>Что видно только по всем встречам сразу</h2>
          <button className="btn small" onClick={refresh} disabled={busy}>{busy ? "Считаем…" : "Обновить"}</button>
        </div>
        {!patterns && <p className="hint">Инсайты появятся после нескольких разобранных встреч. Нажми «Обновить».</p>}
        {patterns && (
          <>
            <div className="insights">
              {patterns.insights.map((ins, i) => (
                <article className="insight" key={i}>
                  <h3 className="h">{ins.title}</h3>
                  <p className="muted">{ins.detail}</p>
                  <div className="row" style={{ gap: 8 }}>
                    {ins.metric && <span className="tag">{metricLabel(ins.metric)}</span>}
                    {ins.meeting_ids.map((id) => (
                      <Link key={id} to={`/meeting/${id}`} className="mono" style={{ fontSize: 11 }}>{titleFor(id)}</Link>
                    ))}
                  </div>
                </article>
              ))}
            </div>
            <div className="grid-2" style={{ marginTop: 24 }}>
              <div>
                <span className="label">Недельная сводка · {fmtDate(patterns.generated_at)}</span>
                <Markdown text={patterns.weekly_summary} className="weekly" />
              </div>
              <div>
                <span className="label">Упражнения под слабую сторону</span>
                <div className="exercises">
                  {patterns.exercises.map((ex, i) => (
                    <div className="exercise" key={i}>
                      <div className="row between">
                        <strong>{ex.title}</strong>
                        <span className="mono faint">{ex.duration_min} мин</span>
                      </div>
                      <p className="muted">{ex.instruction}</p>
                      <div className="row" style={{ gap: 8 }}>
                        {ex.targets_metric && <span className="tag">{metricLabel(ex.targets_metric)}</span>}
                        {ex.training_task_id && <Link to={`/training?task=${ex.training_task_id}`} className="btn small">В тренажёр</Link>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
