import { APP_LABELS } from "../lib/format";
import { useStore } from "../lib/store";

export function MeetingAppBanner({ onRecord }: { onRecord: () => void }) {
  const { meetingApp, dismissedApp, dismissApp, appState, settings } = useStore();
  if (!meetingApp || dismissedApp === meetingApp || appState?.recording || settings?.ask_on_meeting_app === false) return null;
  return (
    <div className="banner">
      <div>
        <span className="tag signal">звонок</span>
        <span className="banner-text">
          Идёт звонок в {APP_LABELS[meetingApp] ?? meetingApp} — начать запись?
        </span>
      </div>
      <div className="row">
        <button className="btn ghost small" onClick={dismissApp}>
          Не сейчас
        </button>
        <button className="btn signal small" onClick={onRecord}>
          <span className="rec-dot" /> Записать
        </button>
      </div>
    </div>
  );
}
