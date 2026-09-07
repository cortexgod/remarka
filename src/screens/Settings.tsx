import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AudioDevice, Settings as S } from "../types/contracts";
import { api } from "../lib/api";
import { useStore } from "../lib/store";

/** Настройки для обычного человека: микрофон, собеседники, подсказки, окно записи, тема. Ничего технического. */
export default function Settings() {
  const { settings, appState, updateSettings, run } = useStore();
  const [devices, setDevices] = useState<AudioDevice[]>([]);

  useEffect(() => {
    api.listAudioDevices().then(setDevices).catch(() => setDevices([]));
  }, []);

  if (!settings) return <div className="page"><p className="faint">Загрузка…</p></div>;
  const set = (patch: Partial<S>) => run(updateSettings(patch));

  return (
    <div className="page">
      <h1 className="title">Настройки</h1>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Запись</h2></div>
        <div className="srows">
          <label className="field" style={{ maxWidth: 420 }}>
            <span className="label">Микрофон</span>
            <select className="select" value={settings.input_device ?? ""} onChange={(e) => set({ input_device: e.target.value || null })}>
              <option value="">как в системе</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_default ? " — сейчас основной" : ""}</option>)}
            </select>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={settings.system_audio_default} disabled={appState?.system_audio_supported === false} onChange={(e) => set({ system_audio_default: e.target.checked })} />
            <span className="sw" />
            <span>Записывать и собеседников<span className="hint">Тогда в разборе появятся доля твоей речи, перебивания и вопросы собеседника. Собеседники попадают в запись — предупреждай их об этом.</span></span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={settings.ask_on_meeting_app} onChange={(e) => set({ ask_on_meeting_app: e.target.checked })} />
            <span className="sw" /><span>Предлагать запись, когда начинается звонок в Zoom или Teams</span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={settings.show_overlay} onChange={(e) => set({ show_overlay: e.target.checked })} />
            <span className="sw" /><span>Показывать маленькое окно с таймером и темпом во время записи<span className="hint">Оно держится поверх других окон и не мешает звонку.</span></span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={settings.auto_analyze} onChange={(e) => set({ auto_analyze: e.target.checked })} />
            <span className="sw" /><span>Разбирать запись сразу после остановки</span>
          </label>
        </div>
      </section>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Внешний вид</h2></div>
        <div className="srows">
          <label className="field" style={{ maxWidth: 280 }}>
            <span className="label">Тема</span>
            <select className="select" value={settings.theme === "light" ? "light" : "dark"} onChange={(e) => set({ theme: e.target.value as S["theme"] })}>
              <option value="dark">тёмная</option>
              <option value="light">светлая</option>
            </select>
          </label>
        </div>
      </section>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Данные</h2></div>
        <div className="srows">
          <p className="hint" style={{ maxWidth: "70ch" }}>
            Записи и разборы хранятся на этом компьютере. Речь распознаётся здесь же, без интернета. Для советов и конспекта на сервер уходит только текст — без звука.
          </p>
          <div className="row">
            <button className="btn" onClick={() => run(api.openDataDir())}>Открыть папку с записями</button>
            <Link to="/profile" className="btn ghost">Профиль</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
