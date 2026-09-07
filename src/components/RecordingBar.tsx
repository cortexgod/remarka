import { fmtTime } from "../lib/format";
import { useStore } from "../lib/store";
import { LevelMeter, TempoBar } from "./Bits";

interface Props {
  onStop: () => void;
  onCancel: () => void;
  title?: string | null;
}

/** Панель идущей записи: таймер, уровень, темп, «Стоп» */
export function RecordingBar({ onStop, onCancel, title }: Props) {
  const { appState, tick } = useStore();
  const rec = appState?.recording;
  if (!rec) return null;
  const elapsed = tick?.elapsed_sec ?? rec.elapsed_sec;
  return (
    <div className="recbar">
      <div className="recbar-main">
        <span className="tag fill">rec</span>
        <span className="rec-time">{fmtTime(elapsed)}</span>
        <span className="muted">{title ?? "Идёт запись"}</span>
      </div>
      <div className="recbar-meters">
        <LevelMeter db={tick?.level_db ?? rec.level_db} label="микрофон" />
        {rec.system_audio && <LevelMeter db={tick?.system_level_db ?? rec.system_level_db} label="система" />}
        <div className="level">
          <span className="label">темп {tick?.wpm_estimate != null ? `${Math.round(tick.wpm_estimate)} сл/мин` : "…"}</span>
          <TempoBar wpm={tick?.wpm_estimate ?? null} />
        </div>
      </div>
      <div className="row">
        <button className="btn ghost small" onClick={onCancel} title="Удалить запись">
          Отменить
        </button>
        <button className="btn primary" onClick={onStop}>
          Стоп
        </button>
      </div>
    </div>
  );
}
