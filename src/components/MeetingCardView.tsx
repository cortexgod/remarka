import { Link } from "react-router-dom";
import type { EvAnalysisProgress, MeetingCard } from "../types/contracts";
import { STAGE_LABELS, capitalize, fmtDate, fmtDur, fmtNum, fmtPct, typeLabel } from "../lib/format";
import { Delta, TypeTag } from "./Bits";

interface Props {
  m: MeetingCard;
  progress?: EvAnalysisProgress;
  onAnalyze: (id: string) => void;
  onDelete: (id: string) => void;
}

export function MeetingCardView({ m, progress, onAnalyze, onDelete }: Props) {
  const title = m.title ?? (m.status === "recording" ? "Идёт запись" : capitalize(typeLabel(m.meeting_type)));
  const delta = m.score != null && m.prev_score != null ? m.score - m.prev_score : null;
  const body = (
    <>
      <div className="mc-head">
        <div className="mc-meta">
          <span className="mono faint">{fmtDate(m.started_at)}</span>
          <span className="mono faint">·</span>
          <span className="mono faint">{fmtDur(m.duration_sec)}</span>
          {m.has_system_track && <span className="tag">две дорожки</span>}
          {m.training_task_id && <span className="tag">тренажёр</span>}
        </div>
        <h3 className="mc-title">{title}</h3>
        <div className="row" style={{ gap: 8 }}>
          <TypeTag type={m.meeting_type} source={m.type_source} />
          {m.status === "analyzing" && <span className="tag signal">анализ</span>}
          {m.status === "recorded" && <span className="tag">не разобрано</span>}
          {m.status === "error" && <span className="tag signal">ошибка</span>}
          {m.status === "recording" && <span className="tag fill">rec</span>}
        </div>
      </div>
      {m.status === "ready" && (
        <div className="mc-nums">
          <div className="kpi">
            <span className="v">
              {m.score ?? "—"}
              {delta != null && (
                <small>
                  <Delta v={delta} digits={0} />
                </small>
              )}
            </span>
            <span className="k">оценка</span>
          </div>
          <div className="kpi">
            <span className="v">
              {m.wpm != null ? fmtNum(m.wpm, 0) : "—"}
              <small>сл/мин</small>
            </span>
            <span className="k">темп</span>
          </div>
          <div className="kpi">
            <span className="v">
              {m.filled_pauses_per_min != null ? fmtNum(m.filled_pauses_per_min, 1) : "—"}
              <small>в мин</small>
            </span>
            <span className="k">э‑э</span>
          </div>
          <div className="kpi">
            <span className="v">{m.talk_ratio != null ? fmtPct(m.talk_ratio) : "—"}</span>
            <span className="k">доля речи</span>
          </div>
        </div>
      )}
      {m.status === "analyzing" && (
        <div className="mc-progress">
          <div className="row between">
            <span className="mono faint">{progress ? `${STAGE_LABELS[progress.stage] ?? progress.stage} · ${progress.message}` : "в очереди"}</span>
            <span className="mono">{progress ? `${progress.pct} %` : ""}</span>
          </div>
          <div className="progress">
            <div className="bar" style={{ width: `${progress?.pct ?? 0}%` }} />
          </div>
        </div>
      )}
      {m.status === "error" && (
        <div className="mc-error">
          <p className="bad">{m.error ?? "Анализ не удался"}</p>
        </div>
      )}
    </>
  );
  return (
    <article className={"mcard status-" + m.status}>
      {m.status === "ready" ? (
        <Link to={`/meeting/${m.id}`} className="mc-link">
          {body}
        </Link>
      ) : (
        <div className="mc-link">{body}</div>
      )}
      <div className="mc-actions">
        {m.status === "error" && (
          <button className="btn small" onClick={() => onAnalyze(m.id)}>
            Повторить
          </button>
        )}
        {m.status === "recorded" && (
          <button className="btn small primary" onClick={() => onAnalyze(m.id)}>
            Разобрать
          </button>
        )}
        {m.status !== "recording" && (
          <button className="btn small ghost" onClick={() => onDelete(m.id)} title="Удалить встречу и файлы">
            Удалить
          </button>
        )}
      </div>
    </article>
  );
}
