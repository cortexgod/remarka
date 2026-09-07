import { useState } from "react";
import type { MeetingType, PrepResult } from "../types/contracts";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { TYPE_ORDER, typeLabel } from "../lib/format";

export default function Prepare() {
  const { run, appState } = useStore();
  const [topic, setTopic] = useState("");
  const [type, setType] = useState<MeetingType>("pitch");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<PrepResult | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());

  const go = async () => {
    if (!topic.trim()) return;
    setBusy(true);
    const r = await run(api.prepareMeeting(topic.trim(), type));
    setBusy(false);
    if (r) {
      setRes(r);
      setDone(new Set());
    }
  };

  return (
    <div className="page">
      <h1 className="title">Подготовка</h1>
      <p className="lede">Опиши, о чём будет встреча, — получишь короткий чеклист и вопросы, которые тебе, скорее всего, зададут.</p>
      {appState && !appState.advice_available && (
        <div className="note soft">
          <p>В этой сборке подготовка недоступна.</p>
          <p className="muted">Чеклист и вопросы строит сервер советов, доступ к которому есть только у автора приложения. Запись, разбор и прогресс работают полностью.</p>
        </div>
      )}
      {(!appState || appState.advice_available) && <div className="card prep-form">
        <label className="field">
          <span className="label">Тема или повестка</span>
          <textarea className="textarea" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Например: питч «Возвратки» фонду ранних стадий, раунд 40 млн, есть 23 платящих магазина" />
        </label>
        <div className="row between">
          <label className="row" style={{ gap: 8 }}>
            <span className="label">Тип встречи</span>
            <select className="select inline" value={type} onChange={(e) => setType(e.target.value as MeetingType)}>
              {TYPE_ORDER.filter((t) => t !== "training").map((t) => (
                <option key={t} value={t}>{typeLabel(t)}</option>
              ))}
            </select>
          </label>
          <button className="btn primary" onClick={go} disabled={busy || !topic.trim()}>{busy ? "Готовим…" : "Подготовить"}</button>
        </div>
      </div>}
      {res && (
        <div className="grid-2 prep-result">
          <div>
            <div className="section-head"><h2 className="h">Чеклист</h2><span className="aside">{typeLabel(res.meeting_type)}</span></div>
            <ul className="checklist">
              {res.checklist.map((c, i) => (
                <li key={i}>
                  <label className="check">
                    <input type="checkbox" checked={done.has(i)} onChange={(e) => { const s = new Set(done); if (e.target.checked) s.add(i); else s.delete(i); setDone(s); }} />
                    <span className={done.has(i) ? "faint" : ""}>{c}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="section-head"><h2 className="h">Что спросят</h2></div>
            <div className="qa">
              {res.likely_questions.map((q, i) => (
                <div className="q" key={i}>
                  <p className="q-asked">{q.question}</p>
                  <p className="muted q-comment"><span className="label">почему</span> {q.why}</p>
                  <p className="q-comment"><span className="label" style={{ color: "var(--ok)" }}>как готовиться</span> {q.how_to_prepare}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
