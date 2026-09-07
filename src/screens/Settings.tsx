import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AudioDevice, EngineDoctor, LlmBackend, MeetingType, Settings as S } from "../types/contracts";
import { api, isTauri } from "../lib/api";
import { useStore } from "../lib/store";
import { TYPE_ORDER, typeLabel } from "../lib/format";

const ASR_MODELS: { id: string; label: string }[] = [
  { id: "large-v3-turbo", label: "Точная — по умолчанию (1,6 ГБ)" },
  { id: "large-v3", label: "Самая точная, но медленная (3 ГБ)" },
  { id: "medium", label: "Средняя (1,5 ГБ)" },
  { id: "small", label: "Быстрая, менее точная (0,5 ГБ)" },
];
const COMPUTE = ["int8", "int8_float16", "float16", "float32"];

export default function Settings() {
  const { settings, appState, updateSettings, run, toast, refreshAppState } = useStore();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [doctor, setDoctor] = useState<EngineDoctor | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [python, setPython] = useState("");
  const [impMic, setImpMic] = useState("");
  const [impSys, setImpSys] = useState("");
  const [impType, setImpType] = useState<MeetingType | "">("");
  const [impTitle, setImpTitle] = useState("");
  const [imported, setImported] = useState<string | null>(null);

  useEffect(() => {
    api.listAudioDevices().then(setDevices).catch(() => setDevices([]));
  }, []);
  useEffect(() => {
    if (settings) {
      setKey(settings.anthropic_api_key ?? "");
      setPython(settings.engine_python ?? "");
    }
  }, [settings]);

  if (!settings) return <div className="page"><p className="faint">Загрузка…</p></div>;
  const set = (patch: Partial<S>) => run(updateSettings(patch));

  const check = async () => {
    setBusy("doctor");
    const d = await run(api.engineDoctor());
    setBusy(null);
    if (d) setDoctor(d);
  };
  const download = async () => {
    setBusy("dl");
    try {
      await api.downloadModel(settings.asr_model);
      toast("Модель распознавания скачана");
      refreshAppState();
    } catch (e) {
      toast(`Не удалось скачать: ${(e as Error).message}`, "err");
    }
    setBusy(null);
  };
  const doImport = async () => {
    setBusy("import");
    const res = await run(
      api.importAudio({
        mic_path: impMic.trim(),
        system_path: impSys.trim() || null,
        meeting_type: impType || null,
        title: impTitle.trim() || null,
      }),
      settings.auto_analyze ? "Запись добавлена — разбор начался" : "Запись добавлена",
    );
    setBusy(null);
    if (res) setImported(res.meeting_id);
  };

  const llmStatus = doctor
    ? doctor.llm_backend_available
      ? "Подключено — советы и конспект будут в каждом разборе."
      : doctor.messages.find((m) => /claude|anthropic|llm|ключ/i.test(m)) ?? "Не подключено."
    : null;

  return (
    <div className="page">
      <h1 className="title">Настройки</h1>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Запись</h2></div>
        <div className="srows">
          <label className="field" style={{ maxWidth: 420 }}>
            <span className="label">Микрофон</span>
            <select className="select" value={settings.input_device ?? ""} onChange={(e) => set({ input_device: e.target.value || null })}>
              <option value="">как в системе</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_default ? " — сейчас основной" : ""}</option>)}
            </select>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={settings.system_audio_default} disabled={appState?.system_audio_supported === false} onChange={(e) => set({ system_audio_default: e.target.checked })} />
            <span className="sw" />
            <span>Записывать и собеседников<span className="hint">Тогда в разборе появятся доля твоей речи, перебивания и вопросы собеседника. Собеседники попадают в запись — предупреждай их об этом.</span></span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={settings.ask_on_meeting_app} onChange={(e) => set({ ask_on_meeting_app: e.target.checked })} />
            <span className="sw" /><span>Предлагать запись, когда начинается звонок в Zoom или Teams</span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={settings.show_overlay} onChange={(e) => set({ show_overlay: e.target.checked })} />
            <span className="sw" /><span>Показывать маленькое окно с таймером и темпом во время записи<span className="hint">Оно держится поверх других окон и не мешает звонку.</span></span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={settings.auto_analyze} onChange={(e) => set({ auto_analyze: e.target.checked })} />
            <span className="sw" /><span>Разбирать запись сразу после остановки</span>
          </label>
        </div>
      </section>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Советы и конспект</h2></div>
        <div className="srows">
          <p className="hint" style={{ maxWidth: 72 + "ch" }}>
            Цифры (темп, паузы, интонация) считаются на этом компьютере. Три правки, конспект и разбор ответов пишет модель Claude — ей уходит только текст, без звука.
          </p>
          <label className="field" style={{ maxWidth: 420 }}>
            <span className="label">Как подключить Claude</span>
            <select className="select" value={settings.llm_backend} onChange={(e) => set({ llm_backend: e.target.value as LlmBackend })}>
              <option value="claude_cli">Через Claude Code на этом компьютере</option>
              <option value="anthropic_api">Через ключ Anthropic</option>
              <option value="none">Не подключать — только цифры</option>
            </select>
          </label>
          {settings.llm_backend === "anthropic_api" && (
            <label className="field" style={{ maxWidth: 420 }}>
              <span className="label">Ключ</span>
              <input className="input mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} onBlur={() => set({ anthropic_api_key: key.trim() || null })} placeholder="sk-ant-…" autoComplete="off" />
              <span className="hint">Хранится только на этом компьютере.</span>
            </label>
          )}
          {settings.llm_backend !== "none" && (
            <div className="row">
              <button className="btn" onClick={check} disabled={busy === "doctor"}>{busy === "doctor" ? "Проверяем…" : "Проверить подключение"}</button>
              {llmStatus && <span className={"hint " + (doctor?.llm_backend_available ? "good" : "warn")}>{llmStatus}</span>}
            </div>
          )}
        </div>
      </section>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Внешний вид</h2></div>
        <div className="srows">
          <label className="field" style={{ maxWidth: 280 }}>
            <span className="label">Тема</span>
            <select className="select" value={settings.theme === "light" ? "light" : "dark"} onChange={(e) => set({ theme: e.target.value as S["theme"] })}>
              <option value="dark">тёмная</option>
              <option value="light">светлая</option>
            </select>
          </label>
          <p className="hint">Профиль — имя, чем занимаешься и что хочешь улучшить — в разделе <Link to="/profile">Профиль</Link>.</p>
        </div>
      </section>

      <details className="advanced">
        <summary>Дополнительно</summary>
        <div className="srows" style={{ marginTop: 14 }}>
          <div className="grid-2">
            <label className="field">
              <span className="label">Модель распознавания речи</span>
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <select className="select" value={settings.asr_model} onChange={(e) => set({ asr_model: e.target.value })}>
                  {ASR_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <button className="btn" onClick={download} disabled={busy === "dl"} title="Скачать модель заранее">{busy === "dl" ? "Скачиваем…" : "Скачать"}</button>
              </div>
              <span className="hint">{appState?.asr_model_cached ? "Модель скачана и готова." : "Модель ещё не скачана — скачается при первом разборе или по кнопке."}</span>
            </label>
            <label className="field">
              <span className="label">Тип вычислений</span>
              <select className="select" value={settings.asr_compute_type} onChange={(e) => set({ asr_compute_type: e.target.value })}>
                {COMPUTE.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <span className="hint">int8 — норма для Mac на чипах Apple.</span>
            </label>
          </div>
          <div className="grid-2">
            <label className="field">
              <span className="label">Модель Claude</span>
              <input className="input mono" value={settings.llm_model} onChange={(e) => set({ llm_model: e.target.value })} />
            </label>
            {settings.llm_backend === "claude_cli" && (
              <label className="field">
                <span className="label">Путь к claude или к SSH‑обёртке</span>
                <input className="input mono" value={settings.llm_cli_path ?? ""} onChange={(e) => set({ llm_cli_path: e.target.value.trim() || null })} placeholder="пусто — искать claude автоматически" />
                <span className="hint">scripts/claude-ssh из репозитория — чтобы модель работала на твоём сервере.</span>
              </label>
            )}
          </div>
          <label className="field">
            <span className="label">Движок анализа (python)</span>
            <input className="input mono" value={python} placeholder="пусто — использовать встроенный" onChange={(e) => setPython(e.target.value)} onBlur={() => set({ engine_python: python.trim() || null })} />
          </label>
          <div className="row">
            <button className="btn" onClick={check} disabled={busy === "doctor"}>{busy === "doctor" ? "Проверяем…" : "Проверить движок"}</button>
            <button className="btn ghost" onClick={() => run(api.openDataDir())}>Открыть папку с записями</button>
          </div>
          {doctor && (
            <div className={"note " + (doctor.ok ? "ok" : "")}>
              <p><strong>{doctor.ok ? "Движок в порядке" : "Движок не готов"}</strong>{doctor.engine_version ? ` · версия ${doctor.engine_version}` : ""}</p>
              {doctor.messages.map((m, i) => <p key={i} className="hint">{m}</p>)}
            </div>
          )}

          <div className="section-head" style={{ marginTop: 10 }}><h2 className="h">Добавить готовую запись</h2></div>
          <p className="hint">WAV‑файл с диктофона или из Zoom. Путь к файлу — текстом.</p>
          <label className="field">
            <span className="label">Файл с твоим голосом (WAV)</span>
            <input className="input mono" value={impMic} onChange={(e) => setImpMic(e.target.value)} placeholder="/Users/…/mic.wav" spellCheck={false} />
          </label>
          <label className="field">
            <span className="label">Файл с собеседниками (WAV, необязательно)</span>
            <input className="input mono" value={impSys} onChange={(e) => setImpSys(e.target.value)} placeholder="/Users/…/system.wav" spellCheck={false} />
          </label>
          <div className="grid-2">
            <label className="field">
              <span className="label">Тип встречи</span>
              <select className="select" value={impType} onChange={(e) => setImpType(e.target.value as MeetingType | "")}>
                <option value="">определить автоматически</option>
                {TYPE_ORDER.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="label">Название</span>
              <input className="input" value={impTitle} onChange={(e) => setImpTitle(e.target.value)} placeholder="необязательно" />
            </label>
          </div>
          <div className="row">
            <button className="btn" onClick={doImport} disabled={busy === "import" || !impMic.trim()}>{busy === "import" ? "Добавляем…" : "Добавить"}</button>
            {imported && <Link to="/" className="hint">Открыть в списке встреч →</Link>}
          </div>
          <p className="hint">{isTauri ? `Папка данных: ${appState?.data_dir ?? "—"}` : "Режим предпросмотра в браузере: данные синтетические."}</p>
        </div>
      </details>
    </div>
  );
}
