import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AudioDevice, EngineDoctor, LlmBackend, MeetingType, Settings as S } from "../types/contracts";
import { api, isTauri } from "../lib/api";
import { useStore } from "../lib/store";
import { TYPE_ORDER, typeLabel } from "../lib/format";

const ASR_MODELS = ["large-v3-turbo", "large-v3", "medium", "small", "base"];
const COMPUTE = ["int8", "int8_float16", "float16", "float32"];

export default function Settings() {
  const { settings, appState, updateSettings, run, toast } = useStore();
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

  if (!settings) return <div className="page"><p className="faint mono">Загрузка…</p></div>;
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
      toast(`Модель ${settings.asr_model} скачана`);
    } catch (e) {
      toast(`Команда скачивания недоступна в этой сборке (${(e as Error).message}). В терминале: cd engine && .venv/bin/python -m remarka_engine download-model --asr-model ${settings.asr_model}`, "err");
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
      settings.auto_analyze ? "Запись импортирована — разбор начался" : "Запись импортирована",
    );
    setBusy(null);
    if (res) setImported(res.meeting_id);
  };

  return (
    <div className="page">
      <p className="eyebrow">Настройки</p>
      <h1 className="title">Как записывать и разбирать</h1>
      <p className="lede">Всё считается локально. Наружу уходит только текст — и только если включён слой смысла.</p>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Запись</h2></div>
        <div className="srows">
          <label className="toggle">
            <input type="checkbox" checked={settings.system_audio_default} disabled={appState?.system_audio_supported === false} onChange={(e) => set({ system_audio_default: e.target.checked })} />
            <span className="sw" />
            <span>Писать системный звук по умолчанию<span className="hint">Собеседники попадают в запись. В ряде юрисдикций нужно согласие всех сторон — предупреждай участников. Без этого разбор работает, но без доли речи и перебиваний.</span></span>
          </label>
          {settings.system_audio_default && <div className="note"><p>Системный звук включён по умолчанию. Перед каждой записью можно выключить его в диалоге «Записать».</p></div>}
          <label className="field">
            <span className="label">Устройство ввода</span>
            <select className="select" value={settings.input_device ?? ""} onChange={(e) => set({ input_device: e.target.value || null })}>
              <option value="">системное по умолчанию</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_default ? " (системный)" : ""}</option>)}
            </select>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={settings.ask_on_meeting_app} onChange={(e) => set({ ask_on_meeting_app: e.target.checked })} />
            <span className="sw" /><span>Предлагать запись, когда запускается Zoom, Teams или Телемост</span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={settings.show_overlay} onChange={(e) => set({ show_overlay: e.target.checked })} />
            <span className="sw" /><span>Оверлей записи в углу экрана<span className="hint">Таймер, уровень и полоска темпа — ничего больше.</span></span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={settings.auto_analyze} onChange={(e) => set({ auto_analyze: e.target.checked })} />
            <span className="sw" /><span>Разбирать сразу после остановки записи</span>
          </label>
        </div>
      </section>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Движок</h2><span className="aside">{appState?.engine_ok ? "найден" : "не найден"}</span></div>
        <div className="srows">
          <div className="grid-2">
            <label className="field">
              <span className="label">Модель распознавания</span>
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <select className="select" value={settings.asr_model} onChange={(e) => set({ asr_model: e.target.value })}>
                  {ASR_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <button className="btn" onClick={download} disabled={busy === "dl"} title="Скачать модель заранее">{busy === "dl" ? "…" : "Скачать"}</button>
              </div>
              <span className="hint">large-v3-turbo — по умолчанию; small — быстро для проверки.</span>
            </label>
            <label className="field">
              <span className="label">Тип вычислений</span>
              <select className="select" value={settings.asr_compute_type} onChange={(e) => set({ asr_compute_type: e.target.value })}>
                {COMPUTE.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <span className="hint">int8 на CPU — норма для M‑серии.</span>
            </label>
          </div>
          <label className="field">
            <span className="label">Python движка</span>
            <input className="input mono" value={python} placeholder="автоопределение (engine/.venv/bin/python)" onChange={(e) => setPython(e.target.value)} onBlur={() => set({ engine_python: python.trim() || null })} />
          </label>
          <div className="row">
            <button className="btn" onClick={check} disabled={busy === "doctor"}>{busy === "doctor" ? "Проверяем…" : "Проверить движок"}</button>
            <button className="btn ghost" onClick={() => run(api.openDataDir())}>Открыть папку данных</button>
            <span className="hint mono">{appState?.data_dir}</span>
          </div>
          {doctor && (
            <div className={"note " + (doctor.ok ? "ok" : "")}>
              <p><strong>{doctor.ok ? "Движок в порядке" : "Движок не готов"}</strong>{doctor.engine_version ? ` · v${doctor.engine_version}` : ""}{doctor.python ? ` · ${doctor.python}` : ""}</p>
              <p>{doctor.asr_model_cached ? "Модель в кэше" : "Модель не скачана"} · {doctor.llm_backend_available ? "LLM доступна" : "LLM недоступна"}</p>
              {doctor.messages.map((m, i) => <p key={i} className="hint">{m}</p>)}
            </div>
          )}
        </div>
      </section>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Слой смысла</h2></div>
        <div className="srows">
          <div className="grid-2">
            <label className="field">
              <span className="label">Бэкенд</span>
              <select className="select" value={settings.llm_backend} onChange={(e) => set({ llm_backend: e.target.value as LlmBackend })}>
                <option value="claude_cli">claude CLI (подписка)</option>
                <option value="anthropic_api">Anthropic API (ключ)</option>
                <option value="none">выключен — только метрики</option>
              </select>
            </label>
            <label className="field">
              <span className="label">Модель</span>
              <input className="input mono" value={settings.llm_model} onChange={(e) => set({ llm_model: e.target.value })} />
            </label>
          </div>
          {settings.llm_backend === "anthropic_api" && (
            <label className="field">
              <span className="label">Ключ API</span>
              <input className="input mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} onBlur={() => set({ anthropic_api_key: key.trim() || null })} placeholder="sk-ant-…" autoComplete="off" />
              <span className="hint">Хранится локально в settings.json; передаётся движку через переменную окружения.</span>
            </label>
          )}
          <p className="hint">В облако уходит только текст транскрипта и посчитанные числа. Аудио не покидает компьютер.</p>
        </div>
      </section>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Импорт записи</h2></div>
        <div className="srows">
          <p className="hint">Готовый WAV с диктофона или из Zoom — любая частота и число каналов, приводится к 16 кГц моно. Путь к файлу — текстом: диалога выбора файла в этой сборке нет.</p>
          <label className="field">
            <span className="label">Микрофон (WAV)</span>
            <input className="input mono" value={impMic} onChange={(e) => setImpMic(e.target.value)} placeholder="/Users/…/mic.wav" spellCheck={false} />
          </label>
          <label className="field">
            <span className="label">Системный звук (WAV, необязательно)</span>
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
            <button className="btn" onClick={doImport} disabled={busy === "import" || !impMic.trim()}>{busy === "import" ? "Импортируем…" : "Импортировать"}</button>
            {imported && <Link to="/" className="hint">Открыть в ленте →</Link>}
          </div>
        </div>
      </section>

      <section className="sgroup">
        <div className="section-head"><h2 className="h">Интерфейс</h2></div>
        <div className="srows">
          <label className="field" style={{ maxWidth: 280 }}>
            <span className="label">Тема</span>
            <select className="select" value={settings.theme} onChange={(e) => set({ theme: e.target.value as S["theme"] })}>
              <option value="system">как в системе</option>
              <option value="light">светлая</option>
              <option value="dark">тёмная</option>
            </select>
          </label>
          <label className="field" style={{ maxWidth: 280 }}>
            <span className="label">Язык распознавания</span>
            <select className="select" value={settings.language} onChange={(e) => set({ language: e.target.value })}>
              <option value="ru">русский</option>
            </select>
          </label>
          <p className="hint">{isTauri ? `Платформа: ${appState?.platform ?? "—"}` : "Режим mock: оболочка Tauri не подключена, данные синтетические."}</p>
        </div>
      </section>
    </div>
  );
}
