import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { MeetingCard, MeetingType, Report } from "../types/contracts";
import { api, audioSrc } from "../lib/api";
import { useStore } from "../lib/store";
import { usePlayer } from "../lib/player";
import { STAGE_LABELS, TYPE_ORDER, capitalize, fmtDateLong, fmtDur, fmtTime, typeLabel } from "../lib/format";
import { Markdown } from "../lib/markdown";
import { Timeline } from "../components/Timeline";
import { Transcript, type Highlight } from "../components/Transcript";
import { BaselineBlock, Kpis, MetricsTable, Prosody, Questions, ScoreBreakdown, ThreeThings } from "../components/ReportBlocks";
import { Delta } from "../components/Bits";

export default function Meeting() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { meetings, progress, run, refreshMeetings } = useStore();
  const [card, setCard] = useState<MeetingCard | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  const fromList = meetings.find((m) => m.id === id) ?? null;
  const status = fromList?.status ?? card?.status;

  // карточка
  useEffect(() => {
    let dead = false;
    api.getMeeting(id).then((c) => !dead && setCard(c)).catch((e) => !dead && setErr((e as Error).message));
    return () => {
      dead = true;
    };
  }, [id]);

  // отчёт + аудио, когда готово
  useEffect(() => {
    if (status !== "ready") return;
    let dead = false;
    setErr(null);
    api.getReport(id).then((r) => !dead && setReport(r)).catch((e) => !dead && setErr((e as Error).message));
    api.getAudioPath(id, "mic").then((p) => !dead && setSrc(audioSrc(p))).catch(() => !dead && setSrc(null));
    return () => {
      dead = true;
    };
  }, [id, status, fromList?.meeting_type]);

  if (err && !report) {
    return (
      <div className="page">
        <Link to="/">← Лента</Link>
        <div className="note" style={{ marginTop: 20 }}>
          <p>{err}</p>
        </div>
      </div>
    );
  }
  const m = fromList ?? card;
  if (!m) return <div className="page"><p className="faint mono">Загрузка…</p></div>;

  if (m.status !== "ready" || !report) {
    const p = progress[m.id];
    return (
      <div className="page">
        <Link to="/">← Лента</Link>
        <p className="eyebrow" style={{ marginTop: 20 }}>{typeLabel(m.meeting_type)} · {fmtDateLong(m.started_at)}</p>
        <h1 className="title">{m.title ?? capitalize(typeLabel(m.meeting_type))}</h1>
        <p className="lede">{fmtDur(m.duration_sec)}{m.has_system_track ? " · две дорожки" : " · только микрофон"}</p>
        {m.status === "analyzing" && (
          <div className="card">
            <div className="row between">
              <span className="mono">{p ? `${STAGE_LABELS[p.stage] ?? p.stage} · ${p.message}` : "Анализ в очереди…"}</span>
              <span className="mono">{p ? `${p.pct} %` : ""}</span>
            </div>
            <div className="progress" style={{ marginTop: 10 }}>
              <div className="bar" style={{ width: `${p?.pct ?? 0}%` }} />
            </div>
            <p className="hint" style={{ marginTop: 10 }}>Стадии: чтение → границы речи → распознавание → выравнивание → паузы → просодия → метрики → смысл → конспект → запись. Тридцать минут аудио — две‑три минуты на ноутбуке.</p>
          </div>
        )}
        {m.status === "recorded" && (
          <div className="card">
            <p>Запись сохранена, разбор ещё не запускался.</p>
            <button className="btn primary" onClick={() => run(api.analyzeMeeting(m.id, null))}>Разобрать</button>
          </div>
        )}
        {m.status === "error" && (
          <div className="note">
            <p><strong>Разбор не удался.</strong> {m.error}</p>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn primary" onClick={() => run(api.analyzeMeeting(m.id, null))}>Повторить</button>
              <Link to="/settings" className="btn">Проверить движок</Link>
            </div>
          </div>
        )}
        {m.status === "recording" && <div className="card"><p>Идёт запись — разбор появится после остановки.</p></div>}
        {m.status === "ready" && !report && <p className="faint mono">Загрузка отчёта…</p>}
      </div>
    );
  }

  return <ReportView key={report.meeting.id + report.meeting.type} report={report} card={m} src={src} onChanged={() => refreshMeetings()} onDeleted={() => nav("/")} />;
}

function ReportView({ report, card, src, onChanged, onDeleted }: { report: Report; card: MeetingCard; src: string | null; onChanged: () => void; onDeleted: () => void }) {
  const { run } = useStore();
  const D = report.meeting.duration_sec;
  const player = usePlayer(src, D);
  const [seekSerial, setSeekSerial] = useState(0);
  const [hl, setHl] = useState<Highlight>({ fillers: true, crutches: true, pauses: true, prosody: false });
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(card.title ?? "");
  const [tab, setTab] = useState<"metrics" | "score">("metrics");

  const seek = useCallback(
    (t: number, andPlay?: boolean) => {
      player.seek(t, andPlay);
      setSeekSerial((s) => s + 1);
    },
    [player.seek],
  );

  // пробел — play/pause
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
      e.preventDefault();
      player.toggle();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [player.toggle]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of report.events) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [report]);

  const changeType = async (t: MeetingType) => {
    await run(api.updateMeeting(card.id, null, t), "Тип встречи обновлён: ориентиры и оценка пересчитаны");
    onChanged();
  };
  const saveTitle = async () => {
    setEditing(false);
    if ((title.trim() || null) === card.title) return;
    await run(api.updateMeeting(card.id, title.trim() || "", null), "Название сохранено");
    onChanged();
  };
  const del = async () => {
    if (!confirm("Удалить встречу вместе с аудио и отчётом?")) return;
    await run(api.deleteMeeting(card.id), "Встреча удалена");
    onDeleted();
  };
  const delta = card.score != null && card.prev_score != null ? card.score - card.prev_score : null;
  const mean = report.meaning;

  return (
    <div className="page page-wide meeting">
      <div className="mt-top">
        <div>
          <Link to="/" className="back">← Лента</Link>
          <p className="eyebrow" style={{ marginTop: 14 }}>
            {fmtDateLong(report.meeting.started_at)} · {fmtDur(D)} · {report.meeting.has_system_track ? "две дорожки" : "только микрофон"}
          </p>
          {editing ? (
            <input className="input title-input" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => e.key === "Enter" && saveTitle()} />
          ) : (
            <h1 className="title" onClick={() => setEditing(true)} title="Нажми, чтобы переименовать">
              {card.title ?? capitalize(typeLabel(report.meeting.type))}
            </h1>
          )}
          <div className="row" style={{ gap: 10 }}>
            <label className="row" style={{ gap: 8 }}>
              <span className="label">тип</span>
              <select className="select inline" value={card.meeting_type} onChange={(e) => changeType(e.target.value as MeetingType)}>
                {TYPE_ORDER.map((t) => (
                  <option key={t} value={t}>{typeLabel(t)}</option>
                ))}
              </select>
            </label>
            <span className="hint">
              {card.type_source === "user" ? "задан вручную" : mean ? `определён моделью, уверенность ${Math.round(mean.meeting_type.confidence * 100)} % — ${mean.meeting_type.reason}` : "по умолчанию"}
            </span>
          </div>
        </div>
        <div className="score-box">
          <div className="kpi big">
            <span className="v">
              {report.score.overall}
              {delta != null && <small><Delta v={delta} digits={0} /></small>}
            </span>
            <span className="k">оценка · {report.score.basis === "baseline" ? "относительно базы" : "по ориентирам"}</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn small ghost" onClick={() => run(api.analyzeMeeting(card.id, null), "Разбор запущен заново")}>Пересчитать</button>
            <button className="btn small ghost" onClick={del}>Удалить</button>
          </div>
        </div>
      </div>

      <Kpis report={report} />

      <div className="player">
        <button className="btn small" onClick={player.toggle} aria-label={player.playing ? "Пауза" : "Слушать"}>
          {player.playing ? "❚❚ Пауза" : "▶ Слушать"}
        </button>
        <span className="mono">{fmtTime(player.time)} / {fmtTime(D)}</span>
        {player.silent && <span className="hint">звук недоступен в браузере — позиция двигается без звука</span>}
        <span className="hint" style={{ marginLeft: "auto" }}>пробел — пауза · клик по таймлайну или слову — переход</span>
      </div>

      <Timeline report={report} time={player.time} onSeek={(t) => seek(t)} />

      <div className="mt-grid">
        <div className="mt-main">
          <div className="section">
            <div className="section-head">
              <h2 className="h">Транскрипт</h2>
              <div className="row hl-toggles">
                <label className="check"><input type="checkbox" checked={hl.fillers} onChange={(e) => setHl({ ...hl, fillers: e.target.checked })} /> <span className="w w-filler">э‑э</span> {counts.filled_pause ?? 0}</label>
                <label className="check"><input type="checkbox" checked={hl.crutches} onChange={(e) => setHl({ ...hl, crutches: e.target.checked })} /> <span className="w w-crutch">как бы</span> {counts.crutch ?? 0}</label>
                <label className="check"><input type="checkbox" checked={hl.pauses} onChange={(e) => setHl({ ...hl, pauses: e.target.checked })} /> паузы {(counts.hesitation_pause ?? 0) + (counts.structural_pause ?? 0)}</label>
                <label className="check"><input type="checkbox" checked={hl.prosody} onChange={(e) => setHl({ ...hl, prosody: e.target.checked })} /> тон {(counts.rising_statement ?? 0) + (counts.decay ?? 0)}</label>
              </div>
            </div>
            <Transcript report={report} time={player.time} playing={player.playing} seekSerial={seekSerial} onSeek={seek} highlight={hl} />
          </div>

          <div className="section">
            <div className="section-head">
              <h2 className="h"><span className="num">Три вещи</span>Что поправить в первую очередь</h2>
              <span className="aside">{mean ? `${mean.backend} · ${mean.model}` : ""}</span>
            </div>
            <ThreeThings report={report} onSeek={seek} />
          </div>

          <div className="section">
            <div className="section-head">
              <h2 className="h"><span className="num">Просодия</span>Как это звучало</h2>
            </div>
            <Prosody report={report} time={player.time} onSeek={seek} />
          </div>

          <div className="section">
            <div className="section-head">
              <h2 className="h"><span className="num">Вопросы</span>Собеседник спросил — ты ответил</h2>
              {mean && (
                <span className="aside">
                  структура: {mean.structure.kept ? "держалась" : "поплыла"}
                </span>
              )}
            </div>
            {mean && <p className="muted" style={{ marginBottom: 14 }}>{mean.structure.comment}</p>}
            <Questions report={report} onSeek={seek} />
          </div>

          {mean && (
            <div className="section">
              <div className="section-head">
                <h2 className="h"><span className="num">Конспект</span>О чём договорились</h2>
              </div>
              <div className="grid-2 summary">
                <Markdown text={mean.summary} />
                <div>
                  <span className="label">Договорённости</span>
                  {mean.agreements.length ? (
                    <table className="t" style={{ marginTop: 8 }}>
                      <tbody>
                        {mean.agreements.map((a, i) => (
                          <tr key={i}>
                            <td>{a.text}</td>
                            <td className="num faint">{a.owner ?? "—"}</td>
                            <td className="num faint">{a.due ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="hint">Договорённостей не зафиксировано.</p>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="section">
            <div className="section-head">
              <h2 className="h"><span className="num">База</span>Сравнение с собой</h2>
            </div>
            <BaselineBlock report={report} />
          </div>
        </div>

        <aside className="mt-side">
          <div className="side-tabs">
            <button className={"tabbtn" + (tab === "metrics" ? " on" : "")} onClick={() => setTab("metrics")}>Все метрики</button>
            <button className={"tabbtn" + (tab === "score" ? " on" : "")} onClick={() => setTab("score")}>Из чего оценка</button>
          </div>
          {tab === "metrics" ? <MetricsTable report={report} /> : <ScoreBreakdown report={report} />}
          <div className="engine-info hint">
            {report.engine.asr_backend} · {report.engine.asr_model} · обработка {fmtDur(report.engine.processing_sec)}
            {report.engine.warnings.map((w, i) => (
              <div key={i} className="warn">{w}</div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
