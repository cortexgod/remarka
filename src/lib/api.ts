/**
 * Типизированные обёртки над invoke/listen (CONTRACTS.md §6.1, EVENTS).
 * В обычном браузере (нет window.__TAURI_INTERNALS__) подменяются mock‑бэкендом из src/mock/.
 */
import { invoke as tauriInvoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type {
  AppState,
  AudioDevice,
  Baseline,
  EngineDoctor,
  EvAnalysisDone,
  EvAnalysisError,
  EvAnalysisProgress,
  EvMeetingApp,
  EvRecordingStarted,
  EvRecordingStopped,
  EvRecordingTick,
  ImportAudioOpts,
  MeetingCard,
  MeetingType,
  PatternsResult,
  PrepResult,
  ProgressData,
  Report,
  Settings,
  StartRecordingOpts,
  TrainingTask,
} from "../types/contracts";

export const isTauri: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface Backend {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen(name: string, cb: (payload: unknown) => void): () => void;
}

let mockPromise: Promise<Backend> | null = null;
function mock(): Promise<Backend> {
  if (!mockPromise) mockPromise = import("../mock/backend").then((m) => m.getMockBackend());
  return mockPromise;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    if (isTauri) return await tauriInvoke<T>(cmd, args);
    const b = await mock();
    return await b.invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
  }
}

export interface EventPayloads {
  "recording:started": EvRecordingStarted;
  "recording:tick": EvRecordingTick;
  "recording:stopped": EvRecordingStopped;
  "analysis:progress": EvAnalysisProgress;
  "analysis:done": EvAnalysisDone;
  "analysis:error": EvAnalysisError;
  "meeting-app:changed": EvMeetingApp;
  "meetings:changed": unknown;
  "settings:changed": Settings;
}

/** Подписка на событие оболочки. Возвращает синхронную отписку (безопасна для StrictMode). */
export function on<K extends keyof EventPayloads>(name: K, cb: (payload: EventPayloads[K]) => void): () => void {
  let dead = false;
  if (isTauri) {
    const p = tauriListen<EventPayloads[K]>(name, (e) => {
      if (!dead) cb(e.payload);
    });
    return () => {
      dead = true;
      p.then((un) => un()).catch(() => undefined);
    };
  }
  let un: (() => void) | null = null;
  mock().then((b) => {
    if (dead) return;
    un = b.listen(name, (p) => {
      if (!dead) cb(p as EventPayloads[K]);
    });
  });
  return () => {
    dead = true;
    un?.();
  };
}

/** Путь к аудио → URL для <audio>. В mock путь уже является URL (mock://…). */
export function audioSrc(path: string): string {
  if (!isTauri) return path;
  return convertFileSrc(path);
}

export const api = {
  getAppState: () => call<AppState>("get_app_state"),
  listAudioDevices: () => call<AudioDevice[]>("list_audio_devices"),
  startRecording: (opts: StartRecordingOpts) => call<{ meeting_id: string }>("start_recording", { opts }),
  stopRecording: () => call<{ meeting_id: string }>("stop_recording"),
  cancelRecording: () => call<void>("cancel_recording"),
  listMeetings: () => call<MeetingCard[]>("list_meetings"),
  getMeeting: (id: string) => call<MeetingCard>("get_meeting", { id }),
  getReport: (id: string) => call<Report>("get_report", { id }),
  analyzeMeeting: (id: string, llm: boolean | null = null) => call<void>("analyze_meeting", { id, llm }),
  deleteMeeting: (id: string) => call<void>("delete_meeting", { id }),
  /** Команды оболочки объявлены с `rename_all = "snake_case"` — ключи аргументов как в контракте. */
  updateMeeting: (id: string, title: string | null, meetingType: MeetingType | null) =>
    call<MeetingCard>("update_meeting", { id, title, meeting_type: meetingType }),
  getAudioPath: (id: string, track: "mic" | "system") => call<string>("get_audio_path", { id, track }),
  getProgress: () => call<ProgressData>("get_progress"),
  getBaseline: () => call<Baseline | null>("get_baseline"),
  getSettings: () => call<Settings>("get_settings"),
  setSettings: (patch: Partial<Settings>) => call<Settings>("set_settings", { patch }),
  engineDoctor: () => call<EngineDoctor>("engine_doctor"),
  prepareMeeting: (topic: string, meetingType: MeetingType) =>
    call<PrepResult>("prepare_meeting", { topic, meeting_type: meetingType }),
  getPatterns: () => call<PatternsResult | null>("get_patterns"),
  refreshPatterns: () => call<PatternsResult>("refresh_patterns"),
  listTrainingTasks: () => call<TrainingTask[]>("list_training_tasks"),
  showMainWindow: () => call<void>("show_main_window"),
  setOverlayVisible: (visible: boolean) => call<void>("set_overlay_visible", { visible }),
  importAudio: (opts: ImportAudioOpts) => call<{ meeting_id: string }>("import_audio", { opts }),
  openDataDir: () => call<void>("open_data_dir"),
  /** Не входит в §6.1 (запрос на изменение контракта): скачать модель ASR заранее. Блокирует до конца загрузки. */
  downloadModel: (asrModel: string) => call<void>("download_model", { asr_model: asrModel }),
};

export type Api = typeof api;
