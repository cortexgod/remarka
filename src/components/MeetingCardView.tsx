import { Link } from "react-router-dom";
import type { EvAnalysisProgress, MeetingCard } from "../types/contracts";
import { STAGE_LABELS, capitalize, fmtClock, fmtDur, fmtNum, fmtPct, typeLabel } from "../lib/format";
import { Delta, ScoreRing, TypeTag } from "./Bits";

interface Props {
  m: MeetingCard;
  progress?: EvAnalysisProgress;
  onAnalyze: (id: string) => void;
  onDelete: (id: string) => void;
}

export function MeetingCardView({ m, progress, onAnalyze, onDelete }: Props) {
  const title = m.title ?? (m.status === "recording" ? "Идёт запись" : capitalize(typeLabel(m.meeting_type)));
  const delta = m.score != null && m.prev_score != null ? m.score - m.prev_score : null;
  const ring =
    m.status === "ready" ? (
      <ScoreRing value={m.score} size={48} />
    ) : (
      <ScoreRing value={null} size={48} text={m.status === "error" ? "!" : m.status === "analyzing" ? "…" : m.status === "recording" ? "●" : "–"} tone={m.status === "error" ? "bad" : m.status === "recording" ? "bad" : "na"} />
    );
  const body = (
    <>
      <div className="mc-ring">{ring}</div>
      <div className="mc-head">
        <div className="mc-meta">
          <span className="mono faint">{fmtClock(m.started_at)}</span>
          <span className="mono faint">·</span>
          <span className="mono faint">{fmtDur(m.duration_sec)}</span>
          {m.has_system_track && <span className="faint">· с собеседниками</span>}
        </div>
        <h3 className="mc-title">{title}</h3>
        <div className="row" style={{ gap: 8 }}>
          <TypeTag type={m.meeting_type} source={m.type_source} />
          {m.status === "analyzing" && <span className="tag signal">разбираем</span>}
          {m.status === "recorded" && <span className="tag">ещё не разобрано</span>}
          {m.status === "error" && <span className="tag fill">не удалось разобрать</span>}
          {m.status === "recording" && <span className="tag fill">идёт запись</span>}
        </div>
      </div>
      {m.status === "ready" && (
        <div className="mc-nums">
          {delta != null && (
            <div className="kpi">
              <span className="v"><Delta v={delta} digits={0} /></span>
              <span className="k">к прошлой</span>
            </div>
          )}
          {m.wpm != null && (
            <div className="kpi">
              <span className="v">
                {fmtNum(m.wpm, 0)}
                <small>слов/мин</small>
              </span>
              <span className="k">темп</span>
            </div>
          )}
          {m.filled_pauses_per_min != null && (
            <div className="kpi">
              <span className="v">
                {fmtNum(m.filled_pauses_per_min, 1)}
                <small>в мин</small>
              </span>
              <span className="k">«э‑э» и «м‑м»</span>
            </div>
          )}
          {m.talk_ratio != null && (
            <div className="kpi">
              <span className="v">{fmtPct(m.talk_ratio)}</span>
              <span className="k">твоя речь</span>
            </div>
          )}
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
          <p className="muted">{m.error ?? "Разбор не удался. Попробуй ещё раз."}</p>
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
          <button className="btn small ghost quiet" onClick={() => onDelete(m.id)} title="Удалить встречу и файлы">
            Удалить
          </button>
        )}
      </div>
    </article>
  );
}
