import { useEffect } from "react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { fmtTime } from "../lib/format";
import { LevelMeter, TempoBar } from "../components/Bits";

/** Оверлей записи: 280×72, прозрачный фон, таймер, уровень, полоска темпа, «Стоп». */
export default function Overlay() {
  const { appState, tick, refreshAppState } = useStore();
  const rec = appState?.recording;
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!appState?.recording) refreshAppState();
    }, 1000);
    return () => window.clearInterval(t);
  }, [appState?.recording, refreshAppState]);

  const stop = async () => {
    try {
      await api.stopRecording();
    } catch (e) {
      console.error(e);
    }
    try {
      // окно оверлея скрывает Rust по событию стопа; на всякий случай — сами
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    } catch {
      /* не Tauri */
    }
  };

  return (
    <div className="overlay" data-tauri-drag-region>
      <div className="ov-left" data-tauri-drag-region>
        <span className={"ov-dot" + (rec ? " on" : "")} />
        <span className="ov-time">{rec ? fmtTime(tick?.elapsed_sec ?? rec.elapsed_sec) : "--:--"}</span>
      </div>
      <div className="ov-mid" data-tauri-drag-region>
        <LevelMeter db={tick?.level_db ?? rec?.level_db ?? null} />
        <TempoBar wpm={tick?.wpm_estimate ?? null} />
        <span className="ov-wpm">{tick?.wpm_estimate != null ? `${tick.wpm_estimate} сл/мин` : rec ? "темп…" : "нет записи"}</span>
      </div>
      <button className="ov-stop" onClick={stop} disabled={!rec} title="Остановить запись">
        Стоп
      </button>
    </div>
  );
}
