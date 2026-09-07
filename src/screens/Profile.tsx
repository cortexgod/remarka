import { useEffect, useState } from "react";
import type { MeetingType, Profile as P } from "../types/contracts";
import { TYPE_LABELS } from "../lib/format";
import { useStore } from "../lib/store";
import { GOAL_OPTIONS } from "../lib/metrics";

const ROLES = ["Фаундер", "Продажи", "Руководитель", "Преподаватель / репетитор", "Разработчик", "Маркетинг", "Консультант", "Студент"];

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Я";
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

/** Профиль: кто говорит и что хочет улучшить. Уходит в советы модели и в обращение по имени. */
export default function Profile() {
  const { settings, updateSettings, run, meetings } = useStore();
  const [p, setP] = useState<P>({ name: "", role: "", about: "", goal_metric: null, typical_meetings: [] });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) setP({ ...settings.profile, typical_meetings: settings.profile.typical_meetings ?? [] });
  }, [settings]);

  if (!settings) return <div className="page"><p className="faint">Загрузка…</p></div>;

  const save = async (next: P) => {
    setP(next);
    const ok = await run(updateSettings({ profile: next }));
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
  };
  const field = (patch: Partial<P>) => save({ ...p, ...patch });
  const ready = meetings.filter((m) => m.status === "ready").length;

  return (
    <div className="page">
      <h1 className="title">Профиль</h1>
      <div className="profile-grid">
        <div className="card profile-card">
          <div className="avatar big">{initials(p.name)}</div>
          <div className="profile-name">{p.name.trim() || "Без имени"}</div>
          <div className="hint">{p.role.trim() || "Занятие не указано"}</div>
          <div className="hint" style={{ marginTop: 10 }}>{ready} {ready === 1 ? "разбор" : ready < 5 ? "разбора" : "разборов"}</div>
        </div>

        <div className="col" style={{ gap: 16 }}>
          <label className="field" style={{ maxWidth: 420 }}>
            <span className="label">Как к тебе обращаться</span>
            <input className="input" value={p.name} placeholder="Имя" onChange={(e) => setP({ ...p, name: e.target.value })} onBlur={() => field({ name: p.name.trim() })} />
          </label>
          <label className="field" style={{ maxWidth: 420 }}>
            <span className="label">Чем занимаешься</span>
            <input className="input" list="roles" value={p.role} placeholder="Например: продажи в B2B" onChange={(e) => setP({ ...p, role: e.target.value })} onBlur={() => field({ role: p.role.trim() })} />
            <datalist id="roles">
              {ROLES.map((r) => <option key={r} value={r} />)}
            </datalist>
          </label>
          <div className="field" style={{ maxWidth: 560 }}>
            <span className="label">Какие созвоны чаще всего</span>
            <div className="chips">
              {(["pitch", "demo", "sales", "interview", "standup", "lecture", "one_on_one"] as MeetingType[]).map((t) => (
                <button key={t} type="button" className={"chip" + (p.typical_meetings.includes(t) ? " on" : "")} onClick={() => field({ typical_meetings: p.typical_meetings.includes(t) ? p.typical_meetings.filter((x) => x !== t) : [...p.typical_meetings, t] })}>{TYPE_LABELS[t]}</button>
              ))}
            </div>
          </div>
          <label className="field" style={{ maxWidth: 560 }}>
            <span className="label">О тебе и о твоих встречах</span>
            <textarea className="textarea" value={p.about} placeholder="О чём обычно созвоны, с кем говоришь, что для тебя важно. Чем больше контекста, тем точнее советы." onChange={(e) => setP({ ...p, about: e.target.value })} onBlur={() => field({ about: p.about.trim() })} />
          </label>
          <label className="field" style={{ maxWidth: 420 }}>
            <span className="label">Что хочешь улучшить в первую очередь</span>
            <select className="select" value={p.goal_metric ?? ""} onChange={(e) => field({ goal_metric: e.target.value || null })}>
              <option value="">Пока не знаю — пусть подскажет разбор</option>
              {GOAL_OPTIONS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            </select>
            <span className="hint">Советы после каждой встречи будут строиться вокруг этой цели.</span>
          </label>
          <p className={"hint " + (saved ? "good" : "")}>{saved ? "Сохранено" : "Сохраняется автоматически"}</p>
        </div>
      </div>
    </div>
  );
}
