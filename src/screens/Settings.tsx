import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AudioDevice, Settings as S } from "../types/contracts";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { LogoMark } from "../components/Logo";

/** Настройки для обычного человека: микрофон, собеседники, подсказки, окно записи, тема. Ничего технического. */
export default function Settings() {
  const { settings, appState, updateSettings, run } = useStore();
  const [devices, setDevices] = useState<AudioDevice[]>([]);

  useEffect(() => {
    api.listAudioDevices().then(setDevices).catch(() => setDevices([]));
  }, []);

  if (!settings) return <div className="page"><p className="faint">Загрузка…</p></div>;
  const set = (patch: Partial<S>) => run(updateSettings(patch));

  const Toggle = ({ k, disabled }: { k: keyof S; disabled?: boolean }) => (
    <label className="toggle">
      <input type="checkbox" checked={!!settings[k]} disabled={disabled} onChange={(e) => set({ [k]: e.target.checked } as Partial<S>)} />
      <span className="sw" />
    </label>
  );

  return (
    <div className="page">
      <h1 className="title">Настройки</h1>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Запись</h2></div>
        <div className="scard">
          <div className="srow">
            <div className="srow-text"><span className="t">Микрофон</span></div>
            <select className="select" value={settings.input_device ?? ""} onChange={(e) => set({ input_device: e.target.value || null })}>
              <option value="">Как в системе</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_default ? " — основной" : ""}</option>)}
            </select>
          </div>
          <div className="srow">
            <div className="srow-text">
              <span className="t">Записывать и собеседников</span>
              <span className="hint">В разборе появятся доля твоей речи, перебивания и вопросы собеседника. Собеседники попадают в запись — предупреждай их.</span>
            </div>
            <Toggle k="system_audio_default" disabled={appState?.system_audio_supported === false} />
          </div>
          <div className="srow">
            <div className="srow-text">
              <span className="t">Предлагать запись, когда начинается звонок</span>
              <span className="hint">Zoom, Google Meet, Teams, Телемост.</span>
            </div>
            <Toggle k="ask_on_meeting_app" />
          </div>
          <div className="srow">
            <div className="srow-text">
              <span className="t">Маленькое окно с таймером и темпом</span>
              <span className="hint">Держится поверх других окон во время записи и не мешает звонку.</span>
            </div>
            <Toggle k="show_overlay" />
          </div>
          <div className="srow">
            <div className="srow-text"><span className="t">Разбирать запись сразу после остановки</span></div>
            <Toggle k="auto_analyze" />
          </div>
        </div>
      </section>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Внешний вид</h2></div>
        <div className="scard">
          <div className="srow">
            <div className="srow-text"><span className="t">Тема</span></div>
            <select className="select" value={settings.theme === "light" ? "light" : "dark"} onChange={(e) => set({ theme: e.target.value as S["theme"] })}>
              <option value="dark">Тёмная</option>
              <option value="light">Светлая</option>
            </select>
          </div>
        </div>
      </section>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Данные</h2></div>
        <div className="scard">
          <div className="srow">
            <div className="srow-text">
              <span className="t">Записи и разборы</span>
              <span className="hint">Хранятся на этом компьютере. Речь распознаётся здесь же, без интернета. Для советов и конспекта на сервер уходит только текст, без звука.</span>
            </div>
            <button className="btn" onClick={() => run(api.openDataDir())}>Открыть папку</button>
          </div>
          <div className="srow">
            <div className="srow-text">
              <span className="t">Профиль</span>
              <span className="hint">Имя, занятие и цель — советы строятся вокруг них.</span>
            </div>
            <Link to="/profile" className="btn">Открыть</Link>
          </div>
        </div>
      </section>

      <section className="sgroup">
        <div className="scard">
          <div className="srow">
            <div className="about">
              <LogoMark size={30} />
              <div className="srow-text">
                <span className="t">Ремарка {__APP_VERSION__}</span>
                <span className="hint">Разбор речи на созвонах.</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
