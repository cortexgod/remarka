import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Baseline, StartRecordingOpts } from "../types/contracts";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { APP_LABELS, plural } from "../lib/format";
import { MeetingCardView } from "../components/MeetingCardView";
import { RecordDialog } from "../components/RecordDialog";
import { RecordingBar } from "../components/RecordingBar";
import { MeetingAppBanner } from "../components/MeetingAppBanner";

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
    if (!confirm("Удалить встречу вместе с аудио и отчётом?")) return;
    await run(api.deleteMeeting(id), "Встреча удалена");
    refreshMeetings();
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">Встречи</h1>
        {!recording && (
          <button
            className="btn signal"
            onClick={() => {
              setPreset(undefined);
              setDialog(true);
            }}
          >
            <span className="rec-dot" /> Записать
          </button>
        )}
      </div>

      {recording && <RecordingBar onStop={stop} onCancel={cancel} title={recTitle} />}
      <MeetingAppBanner
        onRecord={() => {
          setPreset(meetingApp ? `Звонок в ${APP_LABELS[meetingApp] ?? meetingApp}` : undefined);
          setDialog(true);
        }}
      />

      {baseline !== undefined && (
        <div className={"calib " + (baseline ? "ready" : "")}>
          {baseline ? (
            <>
              <span className="tag ok">база готова</span>
              <span>
                Первые три встречи стали твоим базовым уровнем — дальше сравниваем тебя с тобой, ориентиры остаются фоном.{" "}
                <Link to="/progress">Прогресс</Link>
              </span>
            </>
          ) : (
            <>
              <span className="tag">калибровка</span>
              <span>
                {Math.min(readyNonTraining, 3)} из 3 встреч. После третьей появится личная база — и оценка станет относительно тебя, а не таблицы.
              </span>
            </>
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
          <h3>Пока ни одной встречи</h3>
          <p>Нажми «Записать» перед следующим созвоном или начни с тренировки — задание на 60 секунд.</p>
          <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
            <Link to="/training" className="btn">
              Тренировка
            </Link>
          </div>
        </div>
      )}

      {meetings.length > 0 && (
        <>
          <div className="section-head" style={{ marginTop: 4 }}>
            <span className="aside">
              {meetings.length} {plural(meetings.length, "запись", "записи", "записей")}
            </span>
          </div>
          <div className="mlist">
            {meetings.map((m) => (
              <MeetingCardView key={m.id} m={m} progress={progress[m.id]} onAnalyze={analyze} onDelete={del} />
            ))}
          </div>
        </>
      )}

      <RecordDialog open={dialog} onClose={() => setDialog(false)} onStart={start} presetTitle={preset} />
    </div>
  );
}
