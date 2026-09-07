/**
 * Общее состояние оболочки: настройки, AppState, список встреч, прогресс анализа,
 * тик записи, запущенное приложение для звонков, тосты. Подписки на события — один раз.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppState, EvAnalysisProgress, EvRecordingTick, MeetingCard, Settings } from "../types/contracts";
import { api, on } from "./api";
import { applyTheme } from "./theme";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "err";
}

export interface Store {
  settings: Settings | null;
  appState: AppState | null;
  meetings: MeetingCard[];
  meetingsLoaded: boolean;
  progress: Record<string, EvAnalysisProgress>;
  tick: EvRecordingTick | null;
  meetingApp: string | null;
  dismissedApp: string | null;
  toasts: Toast[];
  error: string | null;
  refreshMeetings: () => Promise<void>;
  refreshAppState: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissApp: () => void;
  /** выполнить команду с показом ошибки тостом */
  run: <T>(p: Promise<T>, okText?: string) => Promise<T | undefined>;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [appState, setAppState] = useState<AppState | null>(null);
  const [meetings, setMeetings] = useState<MeetingCard[]>([]);
  const [meetingsLoaded, setMeetingsLoaded] = useState(false);
  const [progress, setProgress] = useState<Record<string, EvAnalysisProgress>>({});
  const [tick, setTick] = useState<EvRecordingTick | null>(null);
  const [meetingApp, setMeetingApp] = useState<string | null>(null);
  const [dismissedApp, setDismissedApp] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [error, setError] = useState<string | null>(null);
  const toastId = useRef(0);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 7000 : 3500);
  }, []);

  const refreshMeetings = useCallback(async () => {
    try {
      const list = await api.listMeetings();
      setMeetings(list);
      setMeetingsLoaded(true);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const refreshAppState = useCallback(async () => {
    try {
      const st = await api.getAppState();
      setAppState(st);
      setMeetingApp(st.meeting_app_running);
      if (st.recording && !tick) {
        setTick({
          meeting_id: st.recording.meeting_id, elapsed_sec: st.recording.elapsed_sec, level_db: st.recording.level_db,
          system_level_db: st.recording.system_level_db, wpm_estimate: st.recording.wpm_estimate,
        });
      }
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const s = await api.setSettings(patch);
    setSettings(s);
    applyTheme(s.theme);
  }, []);

  const run = useCallback(
    async <T,>(p: Promise<T>, okText?: string): Promise<T | undefined> => {
      try {
        const r = await p;
        if (okText) toast(okText);
        return r;
      } catch (e) {
        toast((e as Error).message || "Неизвестная ошибка", "err");
        return undefined;
      }
    },
    [toast],
  );

  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s);
      applyTheme(s.theme);
    }).catch((e) => setError((e as Error).message));
    refreshAppState();
    refreshMeetings();
    const offs = [
      on("recording:started", () => {
        refreshAppState();
        refreshMeetings();
      }),
      on("recording:tick", (t) => setTick(t)),
      on("recording:warning", (w) => toast(w.message, "err")),
      on("recording:stopped", () => {
        setTick(null);
        refreshAppState();
        refreshMeetings();
      }),
      on("analysis:progress", (p) => setProgress((m) => ({ ...m, [p.meeting_id]: p }))),
      on("analysis:done", (d) => {
        setProgress((m) => {
          const c = { ...m };
          delete c[d.meeting_id];
          return c;
        });
        refreshAppState();
        refreshMeetings();
      }),
      on("analysis:error", (d) => {
        setProgress((m) => {
          const c = { ...m };
          delete c[d.meeting_id];
          return c;
        });
        refreshAppState();
        refreshMeetings();
      }),
      on("meeting-app:changed", (e) => {
        setMeetingApp(e.app);
        if (e.app === null) setDismissedApp(null);
      }),
      on("meetings:changed", () => refreshMeetings()),
      on("settings:changed", (s) => {
        setSettings(s);
        applyTheme(s.theme);
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [refreshAppState, refreshMeetings]);

  // системная тема: при theme=system data-theme снят, CSS сам реагирует на prefers-color-scheme

  const value = useMemo<Store>(
    () => ({
      settings, appState, meetings, meetingsLoaded, progress, tick, meetingApp, dismissedApp, toasts, error,
      refreshMeetings, refreshAppState, updateSettings, toast, run,
      dismissApp: () => setDismissedApp(meetingApp),
    }),
    [settings, appState, meetings, meetingsLoaded, progress, tick, meetingApp, dismissedApp, toasts, error, refreshMeetings, refreshAppState, updateSettings, toast, run],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("StoreProvider отсутствует");
  return s;
}
