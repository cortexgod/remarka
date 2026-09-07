/**
 * Mock‑оболочка для браузера: реализует команды §6.1 и события EVENTS на таймерах.
 * Подключается из lib/api.ts, когда нет window.__TAURI_INTERNALS__.
 */
import type {
  AppState,
  Baseline,
  BaselineComparison,
  EngineStage,
  EvAnalysisProgress,
  MeetingCard,
  MeetingType,
  PatternsResult,
  ProgressData,
  ProgressSeriesPoint,
  RecordingState,
  Report,
  Settings,
  StartRecordingOpts,
  ImportAudioOpts,
} from "../types/contracts.ts";
import type { Backend } from "../lib/api";
import { generateReport } from "./report.ts";
import { BASELINE_KEYS } from "./refs.ts";
import {
  AUDIO_DEVICES,
  DATA_DIR,
  DEFAULT_SETTINGS,
  MEETING_SPECS,
  TRAINING_TASKS,
  buildDoctor,
  buildPatterns,
  buildPrep,
  specDate,
  toIsoLocal,
  type MockMeetingSpec,
} from "./data.ts";
import { hashSeed } from "./rng.ts";

const STAGES: { stage: EngineStage; share: number; msg: (pct: number, dur: number) => string }[] = [
  { stage: "load", share: 2, msg: () => "Чтение аудио" },
  { stage: "vad", share: 5, msg: () => "Границы речи (Silero)" },
  { stage: "asr", share: 55, msg: (p, d) => `Распознавание: ${mmss((d * p) / 100)} из ${mmss(d)}` },
  { stage: "align", share: 3, msg: () => "Выравнивание таймкодов" },
  { stage: "fillers", share: 5, msg: () => "Детектор заполненных пауз" },
  { stage: "prosody", share: 10, msg: () => "Просодия: тон и интенсивность" },
  { stage: "metrics", share: 5, msg: () => "Метрики" },
  { stage: "meaning", share: 10, msg: () => "Слой смысла" },
  { stage: "summary", share: 3, msg: () => "Конспект и договорённости" },
  { stage: "write", share: 2, msg: () => "Запись отчёта" },
];

function mmss(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function uuid(): string {
  const h = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${h()}${h()}-${h()}-4${h().slice(1)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${h().slice(1)}-${h()}${h()}${h()}`;
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem("remarka.mock.settings");
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* нет localStorage */
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem("remarka.mock.settings", JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

interface MeetingRow extends MeetingCard {
  spec?: MockMeetingSpec;
  seed: number;
}

class MockBackend implements Backend {
  private listeners = new Map<string, Set<(p: unknown) => void>>();
  private meetings: MeetingRow[] = [];
  private reports = new Map<string, Report>();
  private settings: Settings = loadSettings();
  private baseline: Baseline | null = null;
  private patterns: PatternsResult | null = null;
  private recording: RecordingState | null = null;
  private recTimer: number | null = null;
  private analyzing = new Map<string, number>(); // id → timer
  private meetingApp: string | null = null;
  private now = new Date();

  constructor() {
    for (const spec of MEETING_SPECS) {
      const started_at = specDate(spec, this.now);
      const row: MeetingRow = {
        id: spec.id,
        started_at,
        duration_sec: spec.duration_sec,
        meeting_type: spec.type,
        type_source: spec.type_source,
        title: spec.title,
        status: spec.status,
        score: null,
        prev_score: null,
        has_system_track: spec.has_system_track,
        training_task_id: spec.training_task_id ?? null,
        error: spec.error ?? null,
        wpm: null,
        filled_pauses_per_min: null,
        talk_ratio: null,
        spec,
        seed: spec.seed,
      };
      this.meetings.push(row);
      if (spec.status === "ready") this.materialize(row);
    }
    this.recomputePrev();
    // имитация: через 6 с «запустился Zoom»
    window.setTimeout(() => this.setMeetingApp("zoom"), 6000);
    // имитация: встреча «в анализе» продолжает анализироваться с 38 %
    for (const m of this.meetings) if (m.status === "analyzing") this.runAnalysis(m, 38);
  }

  // ---------- события ----------
  listen(name: string, cb: (payload: unknown) => void): () => void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(cb);
    return () => this.listeners.get(name)?.delete(cb);
  }
  private emit(name: string, payload: unknown): void {
    for (const cb of this.listeners.get(name) ?? []) {
      try {
        cb(payload);
      } catch (e) {
        console.error(e);
      }
    }
  }

  // ---------- отчёты и база ----------
  private readyBefore(row: MeetingRow): MeetingRow[] {
    return this.meetings.filter((m) => m.status === "ready" && m.meeting_type !== "training" && m.started_at < row.started_at && this.reports.has(m.id));
  }

  private ensureBaseline(): void {
    if (this.baseline) return;
    const used = this.meetings.filter((m) => m.status === "ready" && m.meeting_type !== "training" && this.reports.has(m.id)).slice(0, 3);
    if (used.length < 3) return;
    const stats: Baseline["stats"] = {};
    for (const k of BASELINE_KEYS) {
      const vals = used.map((m) => this.metricValue(this.reports.get(m.id)!, k)).filter((v): v is number => v != null);
      if (!vals.length) continue;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const varc = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      const std = Math.max(Math.sqrt(varc), Math.abs(mean) * 0.05, 0.01);
      stats[k] = { mean: Math.round(mean * 100) / 100, std: Math.round(std * 100) / 100, n: vals.length };
    }
    this.baseline = { schema_version: 1, created_at: used[2].started_at, meeting_ids: used.map((m) => m.id), stats };
  }

  private metricValue(r: Report, key: string): number | null {
    const [g, n] = key.split(".");
    const grp = (r.metrics as unknown as Record<string, Record<string, { value: number | null }>>)[g];
    return grp?.[n]?.value ?? null;
  }

  /** Сгенерировать отчёт для готовой встречи и заполнить карточку */
  private materialize(row: MeetingRow): Report {
    const before = this.readyBefore(row);
    const calibratingUsed = Math.min(before.length, 3);
    this.ensureBaseline();
    const useBaseline = this.baseline && row.meeting_type !== "training" && before.length >= 3 ? this.baseline : this.baseline && row.meeting_type === "training" ? this.baseline : null;
    const report = generateReport({
      id: row.id,
      seed: row.seed,
      started_at: row.started_at,
      duration_sec: row.duration_sec,
      type: row.meeting_type,
      type_source: row.type_source,
      title: row.title,
      has_system_track: row.has_system_track,
      training_task_id: row.training_task_id,
      baseline: useBaseline,
      calibrating_used: calibratingUsed,
      asr_model: this.settings.asr_model,
      llm_backend: this.settings.llm_backend,
      llm_model: this.settings.llm_model,
      data_dir: DATA_DIR,
      layer2: row.spec?.layer2,
      scenario: row.spec?.scenario,
    });
    this.reports.set(row.id, report);
    row.score = report.score.overall;
    row.wpm = report.metrics.layer1.wpm.value;
    row.filled_pauses_per_min = report.metrics.layer1.filled_pauses_per_min.value;
    row.talk_ratio = report.metrics.layer1.talk_ratio.value;
    row.status = "ready";
    row.error = null;
    if (row.type_source !== "user" && report.meaning) {
      row.meeting_type = report.meaning.meeting_type.type;
      row.type_source = "llm";
    }
    this.ensureBaseline();
    return report;
  }

  private recomputePrev(): void {
    const sorted = [...this.meetings].sort((a, b) => a.started_at.localeCompare(b.started_at));
    let prev: number | null = null;
    for (const m of sorted) {
      m.prev_score = prev;
      if (m.status === "ready" && m.score != null) prev = m.score;
    }
  }

  private cards(): MeetingCard[] {
    this.recomputePrev();
    return [...this.meetings]
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .map(({ spec: _s, seed: _seed, ...card }) => card);
  }

  private find(id: string): MeetingRow {
    const m = this.meetings.find((x) => x.id === id);
    if (!m) throw `Встреча ${id} не найдена`;
    return m;
  }

  private setMeetingApp(app: string | null): void {
    this.meetingApp = app;
    this.emit("meeting-app:changed", { app });
  }

  // ---------- запись ----------
  private startRecording(opts: StartRecordingOpts): { meeting_id: string } {
    if (this.recording) throw "Запись уже идёт";
    const id = uuid();
    const started_at = toIsoLocal(new Date());
    const row: MeetingRow = {
      id, started_at, duration_sec: 0,
      meeting_type: opts.meeting_type ?? (opts.training_task_id ? "training" : "other"),
      type_source: opts.meeting_type ? "user" : "default",
      title: opts.title ?? null, status: "recording", score: null, prev_score: null,
      has_system_track: opts.system_audio, training_task_id: opts.training_task_id ?? null, error: null,
      wpm: null, filled_pauses_per_min: null, talk_ratio: null, seed: hashSeed(id),
    };
    this.meetings.push(row);
    this.recording = { meeting_id: id, started_at, elapsed_sec: 0, system_audio: opts.system_audio, level_db: -60, system_level_db: opts.system_audio ? -60 : null, wpm_estimate: null };
    this.emit("recording:started", { meeting_id: id, started_at, system_audio: opts.system_audio });
    this.emit("meetings:changed", {});
    const t0 = Date.now();
    let level = -40;
    let sys = -50;
    let wpm = 128;
    let phase = 0;
    this.recTimer = window.setInterval(() => {
      if (!this.recording) return;
      phase += 0.25;
      const speaking = Math.sin(phase * 0.9) + Math.sin(phase * 0.23) > -0.3;
      const target = speaking ? -18 + Math.random() * 6 : -48 + Math.random() * 6;
      level = level + (target - level) * 0.5;
      sys = sys + ((speaking ? -50 : -26 + Math.random() * 5) - sys) * 0.3;
      wpm = Math.max(85, Math.min(175, wpm + (Math.random() - 0.5) * 12 + (phase < 20 ? 0.6 : -0.2)));
      const elapsed = (Date.now() - t0) / 1000;
      this.recording.elapsed_sec = elapsed;
      this.recording.level_db = Math.round(level * 10) / 10;
      this.recording.system_level_db = opts.system_audio ? Math.round(sys * 10) / 10 : null;
      this.recording.wpm_estimate = elapsed > 3 ? Math.round(wpm) : null;
      row.duration_sec = elapsed;
      this.emit("recording:tick", { meeting_id: id, elapsed_sec: elapsed, level_db: this.recording.level_db, system_level_db: this.recording.system_level_db, wpm_estimate: this.recording.wpm_estimate });
    }, 250);
    return { meeting_id: id };
  }

  private stopRecording(): { meeting_id: string } {
    if (!this.recording) throw "Запись не идёт";
    const { meeting_id, elapsed_sec } = this.recording;
    if (this.recTimer) window.clearInterval(this.recTimer);
    this.recTimer = null;
    this.recording = null;
    const row = this.find(meeting_id);
    row.duration_sec = Math.max(1, Math.round(elapsed_sec * 10) / 10);
    row.status = "recorded";
    this.emit("recording:stopped", { meeting_id, duration_sec: row.duration_sec });
    this.emit("meetings:changed", {});
    if (this.settings.auto_analyze) window.setTimeout(() => this.runAnalysis(row, 0), 300);
    return { meeting_id };
  }

  private cancelRecording(): void {
    if (!this.recording) return;
    const { meeting_id } = this.recording;
    if (this.recTimer) window.clearInterval(this.recTimer);
    this.recTimer = null;
    this.recording = null;
    this.meetings = this.meetings.filter((m) => m.id !== meeting_id);
    this.emit("recording:stopped", { meeting_id, duration_sec: 0 });
    this.emit("meetings:changed", {});
  }

  // ---------- анализ ----------
  private runAnalysis(row: MeetingRow, fromPct: number): void {
    if (this.analyzing.has(row.id)) return;
    row.status = "analyzing";
    row.error = null;
    this.emit("meetings:changed", {});
    let pct = fromPct;
    const total = row.duration_sec > 600 ? 22 : 12; // секунд на весь анализ
    const stepPct = (100 - fromPct) / ((total * 1000) / 350);
    const tick = () => {
      pct = Math.min(100, pct + stepPct * (0.7 + Math.random() * 0.6));
      let acc = 0;
      let st = STAGES[STAGES.length - 1];
      for (const s of STAGES) {
        acc += s.share;
        if (pct <= acc) {
          st = s;
          break;
        }
      }
      const ev: EvAnalysisProgress = { meeting_id: row.id, stage: st.stage, pct: Math.round(pct), message: st.msg(pct, row.duration_sec) };
      this.emit("analysis:progress", ev);
      if (pct >= 100) {
        window.clearInterval(timer);
        this.analyzing.delete(row.id);
        if (row.duration_sec < 5) {
          row.status = "error";
          row.error = "Запись короче 5 секунд — анализировать нечего.";
          this.emit("analysis:error", { meeting_id: row.id, message: row.error });
        } else {
          try {
            const report = this.materialize(row);
            this.recomputePrev();
            this.emit("analysis:done", { meeting_id: row.id, score: report.score.overall });
          } catch (e) {
            row.status = "error";
            row.error = `Движок упал на стадии «запись отчёта»: ${(e as Error).message}`;
            console.error(e);
            this.emit("analysis:error", { meeting_id: row.id, message: row.error });
          }
        }
        this.emit("meetings:changed", {});
      }
    };
    const timer = window.setInterval(tick, 350);
    this.analyzing.set(row.id, timer);
  }

  // ---------- прогресс ----------
  private progress(): ProgressData {
    const ready = this.meetings.filter((m) => m.status === "ready" && this.reports.has(m.id)).sort((a, b) => a.started_at.localeCompare(b.started_at));
    const series: Record<string, ProgressSeriesPoint[]> = {};
    const keys = [
      "layer1.wpm", "layer1.filled_pauses_per_min", "layer1.crutch_words_per_min", "layer1.hesitation_pauses_per_min",
      "layer1.structural_pauses_per_min", "layer1.talk_ratio", "layer1.mean_sentence_len", "layer2.pitch_range_st",
      "layer2.phrase_final_decay_db", "layer2.rising_statements_share", "layer2.loudness_drift_db",
    ];
    for (const k of keys) {
      series[k] = [];
      for (const m of ready) {
        const v = this.metricValue(this.reports.get(m.id)!, k);
        if (v != null) series[k].push({ meeting_id: m.id, started_at: m.started_at, value: v, meeting_type: m.meeting_type });
      }
    }
    const score = ready.map((m) => ({ meeting_id: m.id, started_at: m.started_at, value: m.score ?? 0, meeting_type: m.meeting_type }));
    // серия рабочих дней подряд с записью
    const days = new Set(this.meetings.filter((m) => m.status !== "recording").map((m) => m.started_at.slice(0, 10)));
    let streak = 0;
    const d = new Date();
    for (let i = 0; i < 60; i++) {
      const key = toIsoLocal(d).slice(0, 10);
      const wd = d.getDay();
      if (wd === 0 || wd === 6) {
        d.setDate(d.getDate() - 1);
        continue;
      }
      if (days.has(key)) streak++;
      else if (i > 0) break;
      d.setDate(d.getDate() - 1);
    }
    const now = new Date();
    const ym = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
    const thisM = ym(now);
    const prevD = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevM = ym(prevD);
    const avg = (month: string) => {
      const out: Record<string, number | null> = {};
      for (const k of [...keys, "score"]) {
        const pts = (k === "score" ? score : series[k]).filter((p) => p.started_at.slice(0, 7) === month);
        out[k] = pts.length ? Math.round((pts.reduce((a, p) => a + p.value, 0) / pts.length) * 100) / 100 : null;
      }
      return out;
    };
    const baseline: BaselineComparison | null = this.baseline
      ? { status: "ready", meetings_used: 3, meetings_needed: 3, deltas: [] }
      : { status: "calibrating", meetings_used: Math.min(3, ready.filter((m) => m.meeting_type !== "training").length), meetings_needed: 3, deltas: [] };
    return { series, score, streak_days: streak, meetings_total: this.meetings.length, this_month: avg(thisM), prev_month: avg(prevM), baseline };
  }

  private appState(): AppState {
    return {
      recording: this.recording,
      analyzing: [...this.analyzing.keys()],
      engine_ok: true,
      platform: "macos",
      system_audio_supported: true,
    asr_model: "large-v3-turbo",
    asr_model_cached: true,
    advice_available: true,
      meeting_app_running: this.meetingApp,
      data_dir: DATA_DIR,
    };
  }

  // ---------- команды ----------
  async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const delay = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
    const a = args as Record<string, never>;
    switch (cmd) {
      case "get_app_state":
        return this.appState() as T;
      case "list_audio_devices":
        return AUDIO_DEVICES as T;
      case "start_recording":
        return this.startRecording(a.opts as StartRecordingOpts) as T;
      case "stop_recording":
        return this.stopRecording() as T;
      case "cancel_recording":
        this.cancelRecording();
        return undefined as T;
      case "list_meetings":
        await delay(60);
        return this.cards() as T;
      case "get_meeting":
        return this.cards().find((m) => m.id === a.id) as T;
      case "get_report": {
        const row = this.find(a.id);
        if (row.status !== "ready") throw "Отчёт ещё не готов";
        await delay(80);
        return (this.reports.get(row.id) ?? this.materialize(row)) as T;
      }
      case "analyze_meeting": {
        const row = this.find(a.id);
        if (row.status === "analyzing") return undefined as T;
        this.runAnalysis(row, 0);
        return undefined as T;
      }
      case "delete_meeting": {
        const id = a.id as string;
        const t = this.analyzing.get(id);
        if (t) window.clearInterval(t);
        this.analyzing.delete(id);
        this.meetings = this.meetings.filter((m) => m.id !== id);
        this.reports.delete(id);
        this.emit("meetings:changed", {});
        return undefined as T;
      }
      case "update_meeting": {
        const row = this.find(a.id);
        const title = (a.title ?? null) as string | null;
        const mt = ((a as Record<string, unknown>).meeting_type ?? (a as Record<string, unknown>).meetingType ?? null) as MeetingType | null;
        if (title !== null) row.title = title;
        if (mt) {
          row.meeting_type = mt;
          row.type_source = "user";
          if (row.status === "ready") this.materialize(row); // статусы пересчитываются под новый тип
        }
        this.emit("meetings:changed", {});
        return this.cards().find((m) => m.id === row.id) as T;
      }
      case "get_audio_path": {
        const row = this.find(a.id);
        if (a.track === "system" && !row.has_system_track) throw "Системной дорожки нет";
        return `mock://silent/${row.id}/${a.track}?duration=${row.duration_sec}` as T;
      }
      case "get_progress":
        await delay(80);
        return this.progress() as T;
      case "get_baseline":
        return this.baseline as T;
      case "get_settings":
        return { ...this.settings } as T;
      case "set_settings": {
        this.settings = { ...this.settings, ...(a.patch as Partial<Settings>) };
        saveSettings(this.settings);
        this.emit("settings:changed", { ...this.settings });
        return { ...this.settings } as T;
      }
      case "engine_doctor":
        await delay(700);
        return buildDoctor(this.settings) as T;
      case "prepare_meeting":
        await delay(1200);
        return buildPrep(a.topic as string, ((a as Record<string, unknown>).meeting_type ?? (a as Record<string, unknown>).meetingType) as MeetingType) as T;
      case "get_patterns": {
        if (!this.patterns) {
          const ids = this.meetings.filter((m) => m.status === "ready").sort((x, y) => x.started_at.localeCompare(y.started_at)).map((m) => m.id);
          this.patterns = buildPatterns(ids, toIsoLocal(new Date(Date.now() - 36e5 * 5)));
        }
        return this.patterns as T;
      }
      case "refresh_patterns": {
        await delay(1500);
        const ids = this.meetings.filter((m) => m.status === "ready").sort((x, y) => x.started_at.localeCompare(y.started_at)).map((m) => m.id);
        this.patterns = buildPatterns(ids, toIsoLocal(new Date()));
        return this.patterns as T;
      }
      case "list_training_tasks":
        return TRAINING_TASKS as T;
      case "show_main_window":
      case "set_overlay_visible":
      case "open_data_dir":
        return undefined as T;
      case "import_audio": {
        const opts = a.opts as ImportAudioOpts;
        const id = uuid();
        this.meetings.push({
          id, started_at: opts.started_at ?? toIsoLocal(new Date()), duration_sec: 600, meeting_type: opts.meeting_type ?? "other",
          type_source: opts.meeting_type ? "user" : "default", title: opts.title ?? null, status: "recorded", score: null, prev_score: null,
          has_system_track: !!opts.system_path, training_task_id: null, error: null, wpm: null, filled_pauses_per_min: null, talk_ratio: null, seed: hashSeed(id),
        });
        this.emit("meetings:changed", {});
        return { meeting_id: id } as T;
      }
      case "download_model":
        await delay(1500);
        return undefined as T;
      default:
        throw `Команда ${cmd} не реализована в mock`;
    }
  }
}

let instance: MockBackend | null = null;
export function getMockBackend(): Backend {
  if (!instance) {
    instance = new MockBackend();
    // отладочный доступ из консоли браузера: window.__remarkaMock.invoke("start_recording", { opts: {…} })
    (window as unknown as { __remarkaMock?: Backend }).__remarkaMock = instance;
  }
  return instance;
}
