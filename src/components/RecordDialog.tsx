import { useEffect, useState } from "react";
import type { AudioDevice, MeetingType, StartRecordingOpts } from "../types/contracts";
import { TYPE_ORDER, typeLabel } from "../lib/format";
import { api } from "../lib/api";
import { useStore } from "../lib/store";

interface Props {
  open: boolean;
  onClose: () => void;
  onStart: (opts: StartRecordingOpts) => void;
  presetTitle?: string;
}

export function RecordDialog({ open, onClose, onStart, presetTitle }: Props) {
  const { settings, appState } = useStore();
  const [title, setTitle] = useState(presetTitle ?? "");
  const [type, setType] = useState<MeetingType | "">("");
  const [system, setSystem] = useState(settings?.system_audio_default ?? false);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [device, setDevice] = useState<string>(settings?.input_device ?? "");

  useEffect(() => {
    if (!open) return;
    setTitle(presetTitle ?? "");
    setSystem(settings?.system_audio_default ?? false);
    setDevice(settings?.input_device ?? "");
    api.listAudioDevices().then(setDevices).catch(() => setDevices([]));
  }, [open, presetTitle, settings]);

  if (!open) return null;
  const sysSupported = appState?.system_audio_supported ?? true;
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Новая запись">
        <p className="eyebrow">Новая запись</p>
        <h2 className="h">Что записываем</h2>
        <div className="col" style={{ gap: 16, marginTop: 16 }}>
          <label className="field">
            <span className="label">Название</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: питч фонду «Восход»" autoFocus />
          </label>
          <label className="field">
            <span className="label">Тип встречи</span>
            <select className="select" value={type} onChange={(e) => setType(e.target.value as MeetingType | "")}>
              <option value="">определить автоматически</option>
              {TYPE_ORDER.filter((t) => t !== "training").map((t) => (
                <option key={t} value={t}>
                  {typeLabel(t)}
                </option>
              ))}
            </select>
          </label>
          {devices.length > 0 && (
            <label className="field">
              <span className="label">Микрофон</span>
              <select className="select" value={device} onChange={(e) => setDevice(e.target.value)}>
                <option value="">по умолчанию</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.is_default ? " (системный)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="toggle">
            <input type="checkbox" checked={system} disabled={!sysSupported} onChange={(e) => setSystem(e.target.checked)} />
            <span className="sw" />
            <span>
              Писать системный звук (собеседников)
              {!sysSupported && <span className="hint">На этой системе недоступно</span>}
            </span>
          </label>
          {system && (
            <div className="note">
              <p>
                Запись собеседников юридически скользкая: в ряде юрисдикций нужно согласие всех сторон. Предупреди участников. Без системного звука
                разбор работает полностью, только без доли речи и перебиваний.
              </p>
            </div>
          )}
        </div>
        <div className="row between" style={{ marginTop: 22 }}>
          <button className="btn ghost" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn signal"
            onClick={() =>
              onStart({ system_audio: system, title: title.trim() || null, meeting_type: type || null, input_device: device || null })
            }
          >
            <span className="rec-dot" /> Начать запись
          </button>
        </div>
      </div>
    </div>
  );
}
