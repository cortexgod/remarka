import { useState } from "react";
import type { MeetingType, PrepResult } from "../types/contracts";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { TYPE_ORDER, typeLabel } from "../lib/format";

export default function Prepare() {
  const { run } = useStore();
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
      <p className="eyebrow">Подготовка</p>
      <h1 className="title">Три вопроса, которые зададут</h1>
      <p className="lede">Вставь тему или повестку — получишь чеклист под тип встречи и вопросы, к которым стоит подготовиться заранее.</p>
      <div className="card prep-form">
        <label className="field">
          <span className="label">Тема или повестка</span>
          <textarea className="textarea" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Например: питч «Возвратки» фонду ранних стадий, раунд 40 млн, есть 23 платящих магазина" />
        </label>
        <div className="row between">
          <label className="row" style={{ gap: 8 }}>
            <span className="label">тип</span>
            <select className="select inline" value={type} onChange={(e) => setType(e.target.value as MeetingType)}>
              {TYPE_ORDER.filter((t) => t !== "training").map((t) => (
                <option key={t} value={t}>{typeLabel(t)}</option>
              ))}
            </select>
          </label>
          <button className="btn primary" onClick={go} disabled={busy || !topic.trim()}>{busy ? "Думаем…" : "Подготовить"}</button>
        </div>
      </div>
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
            <div className="section-head"><h2 className="h">Спросят</h2><span className="aside">{res.backend}</span></div>
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
