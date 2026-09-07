import { useEffect, useMemo, useState } from "react";
import { FirstRun } from "../components/FirstRun";
import { Link } from "react-router-dom";
import type { Baseline, MeetingCard, StartRecordingOpts } from "../types/contracts";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { APP_LABELS, dayLabel } from "../lib/format";
import { MeetingCardView } from "../components/MeetingCardView";
import { RecordDialog } from "../components/RecordDialog";
import { RecordingBar } from "../components/RecordingBar";
import { MeetingAppBanner } from "../components/MeetingAppBanner";
import { EmptyArt } from "../components/Bits";

export default function Feed() {
  const { meetings, meetingsLoaded, progress, appState, meetingApp, run, refreshMeetings, error } = useStore();
  const [dialog, setDialog] = useState(false);
  const [preset, setPreset] = useState<string | undefined>();
  const [baseline, setBaseline] = useState<Baseline | null | undefined>();

  const readyKey = meetings.map((m) => m.id + ":" + m.status).join("|");
  useEffect(() => {
    api.getBaseline().then(setBaseline).catch(() => setBaseline(null));
  }, [readyKey]);

  const readyNonTraining = useMemo(() => meetings.filter((m) => m.status === "ready" && m.meeting_type !== "training").length, [meetings]);
  const groups = useMemo(() => {
    const out: { label: string; items: MeetingCard[] }[] = [];
    for (const m of meetings) {
      const label = dayLabel(m.started_at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(m);
      else out.push({ label, items: [m] });
    }
    return out;
  }, [meetings]);
  const recording = appState?.recording;
  const recTitle = recording ? meetings.find((m) => m.id === recording.meeting_id)?.title : null;

  const start = async (opts: StartRecordingOpts) => {
    setDialog(false);
    await run(api.startRecording(opts), "Запись началась");
  };
  const stop = async () => {
    await run(api.stopRecording(), "Запись остановлена");
  };
  const cancel = async () => {
    if (!confirm("Удалить текущую запись?")) return;
    await run(api.cancelRecording());
  };
  const analyze = (id: string) => run(api.analyzeMeeting(id, null));
  const del = async (id: string) => {
    if (!confirm("Удалить встречу вместе с аудио и разбором?")) return;
    await run(api.deleteMeeting(id), "Встреча удалена");
    refreshMeetings();
  };
  const openDialog = () => {
    setPreset(undefined);
    setDialog(true);
  };
  const done = Math.min(readyNonTraining, 3);

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">Встречи</h1>
        {!recording && (
          <button className="btn signal" onClick={openDialog}>
            <span className="rec-dot" /> Записать
          </button>
        )}
      </div>

      <FirstRun />
      {recording && <RecordingBar onStop={stop} onCancel={cancel} title={recTitle} />}
      <MeetingAppBanner
        onRecord={() => {
          setPreset(meetingApp ? `Звонок в ${APP_LABELS[meetingApp] ?? meetingApp}` : undefined);
          setDialog(true);
        }}
      />

      {baseline !== undefined && meetings.length > 0 && (
        <div className={"calib " + (baseline ? "ready" : "")}>
          <div className="calib-steps" aria-hidden="true">
            {[0, 1, 2].map((i) => <span key={i} className={baseline || i < done ? "on" : ""} />)}
          </div>
          {baseline ? (
            <span>
              <strong>Обычная манера известна.</strong> Оценка теперь показывает, лучше или хуже обычного ты говорил. <Link to="/progress">Прогресс</Link>
            </span>
          ) : (
            <span>
              <strong>Знакомство: {done} из 3 встреч.</strong> После третьей приложение поймёт твою обычную манеру и будет сравнивать тебя с тобой, а не с таблицей.
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="note">
          <p>{error}</p>
        </div>
      )}

      {meetingsLoaded && meetings.length === 0 && (
        <div className="empty">
          <EmptyArt />
          <h3>Здесь появятся твои встречи</h3>
          <p>Нажми «Записать» перед следующим созвоном. Хочется попробовать прямо сейчас — есть тренировка на минуту.</p>
          <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
            <button className="btn signal" onClick={openDialog}>
              <span className="rec-dot" /> Записать
            </button>
            <Link to="/training" className="btn">
              Тренировка
            </Link>
          </div>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.label} className="day-group">
          <div className="day-head">{g.label}</div>
          <div className="mlist">
            {g.items.map((m) => (
              <MeetingCardView key={m.id} m={m} progress={progress[m.id]} onAnalyze={analyze} onDelete={del} />
            ))}
          </div>
        </section>
      ))}

      <RecordDialog open={dialog} onClose={() => setDialog(false)} onStart={start} presetTitle={preset} />
    </div>
  );
}
