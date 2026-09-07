import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkline } from "../components/Bits";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { TrainingTask } from "../types/contracts";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { fmtDate, fmtNum, fmtTime } from "../lib/format";
import { metricLabel } from "../lib/metrics";
import { LevelMeter, TempoBar } from "../components/Bits";

export default function Training() {
  const { appState, tick, run, meetings } = useStore();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [tasks, setTasks] = useState<TrainingTask[]>([]);
  const [sel, setSel] = useState<string | null>(params.get("task"));
  const stopping = useRef(false);

  useEffect(() => {
    api.listTrainingTasks().then((t) => {
      setTasks(t);
      if (!sel && t.length) setSel(t[0].id);
    }).catch(() => setTasks([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const task = useMemo(() => tasks.find((t) => t.id === sel) ?? null, [tasks, sel]);
  const rec = appState?.recording;
  const recMeeting = rec ? meetings.find((m) => m.id === rec.meeting_id) : null;
  const isMine = !!rec && recMeeting?.training_task_id != null;
  const elapsed = tick?.elapsed_sec ?? rec?.elapsed_sec ?? 0;
  const activeTask = isMine ? tasks.find((t) => t.id === recMeeting?.training_task_id) ?? task : null;
  const left = activeTask ? Math.max(0, activeTask.duration_sec - elapsed) : 0;
  const wpm = tick?.wpm_estimate ?? null;

  // история темпа за запись (тики раз в 250 мс) — для живого графика
  const [history, setHistory] = useState<number[]>([]);
  const lastMine = useRef<string | null>(null);
  useEffect(() => {
    if (isMine && rec) {
      lastMine.current = rec.meeting_id;
      if (wpm != null) setHistory((h) => [...h.slice(-239), wpm]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, isMine]);
  // запись кончилась (стоп, автостоп по времени или обрыв) — сразу в разбор, а не в ленту
  useEffect(() => {
    if (!rec && lastMine.current) {
      const id = lastMine.current;
      lastMine.current = null;
      setHistory([]);
      nav(`/meeting/${id}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec]);

  const start = async () => {
    if (!task) return;
    await run(api.startRecording({ system_audio: false, meeting_type: "training", training_task_id: task.id, title: task.title }));
  };
  const stop = async () => {
    if (stopping.current) return;
    stopping.current = true;
    await run(api.stopRecording());
    stopping.current = false;
  };
  // автостоп по времени задания
  useEffect(() => {
    if (isMine && activeTask && elapsed >= activeTask.duration_sec) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed, isMine]);

  const attempts = useMemo(() => meetings.filter((m) => m.training_task_id === sel && m.status === "ready").slice(0, 5), [meetings, sel]);

  return (
    <div className="page">
      <h1 className="title">Режим без Zoom</h1>
      <p className="lede">Задание, запись только с микрофона, разбор — как после настоящей встречи. Пишется ровно столько, сколько длится задание.</p>

      <div className="training">
        <div className="tasks">
          {tasks.map((t) => (
            <button
              key={t.id}
              className={"task" + (t.id === sel ? " on" : "")}
              onClick={() => {
                setSel(t.id);
                setParams({ task: t.id });
              }}
              disabled={!!rec}
            >
              <span className="mono faint">{fmtTime(t.duration_sec)}</span>
              <span className="task-title">{t.title}</span>
              <span className="hint">{t.targets_metric ? metricLabel(t.targets_metric) : "смысл ответа"}</span>
            </button>
          ))}
        </div>
        <div className="task-panel card">
          {!task && <p className="hint">Выбери задание.</p>}
          {task && !isMine && (
            <>
              <p className="eyebrow">{fmtTime(task.duration_sec)} · {task.targets_metric ? metricLabel(task.targets_metric) : "без метрики"}</p>
              <h2 className="h" style={{ marginBottom: 10 }}>{task.title}</h2>
              <p className="task-instr">{task.instruction}</p>
              {rec ? (
                <div className="note soft"><p>Сейчас идёт другая запись — останови её в <Link to="/">ленте</Link>.</p></div>
              ) : (
                <button className="btn signal" onClick={start}><span className="rec-dot" /> Начать</button>
              )}
              {attempts.length > 0 && (
                <div style={{ marginTop: 22 }}>
                  <span className="label">Прошлые попытки</span>
                  <table className="t" style={{ marginTop: 6 }}>
                    <tbody>
                      {attempts.map((a) => (
                        <tr key={a.id}>
                          <td><Link to={`/meeting/${a.id}`}>{fmtDate(a.started_at)}</Link></td>
                          <td className="num">оценка {a.score ?? "—"}</td>
                          <td className="num">{a.filled_pauses_per_min != null ? `э‑э ${fmtNum(a.filled_pauses_per_min, 1)} в мин` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {isMine && activeTask && (
            <div className="training-live">
              <p className="eyebrow">{activeTask.title}</p>
              <div className="live-row">
                <div>
                  <div className="big-timer">{fmtTime(left)}</div>
                  <span className="hint">осталось</span>
                </div>
                <div>
                  <div className="big-timer accent">{wpm != null ? `≈${Math.round(wpm)}` : "—"}</div>
                  <span className="hint">сл/мин сейчас · ориентир 100–130 · оценка по слогам, точный темп будет в разборе</span>
                </div>
              </div>
              <TempoBar wpm={wpm} />
              <Sparkline values={history} lo={100} hi={130} />
              <p className="muted" style={{ marginTop: 14 }}>{activeTask.instruction}</p>
              <LevelMeter db={tick?.level_db ?? rec?.level_db ?? null} label="микрофон" />
              <div className="row" style={{ marginTop: 18 }}>
                <button className="btn primary" onClick={stop}>Стоп и разобрать</button>
                <button className="btn ghost" onClick={() => run(api.cancelRecording())}>Отменить</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
