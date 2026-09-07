import { useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";

/** Первый запуск: модель распознавания ещё не скачана — предложить скачать сразу, а не в момент первого разбора. */
export function FirstRun() {
  const { appState, refreshAppState, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (!appState || appState.asr_model_cached || hidden) return null;
  const download = async () => {
    setBusy(true);
    try {
      await api.downloadModel(appState.asr_model);
      toast("Готово: модель скачана, можно записывать");
      refreshAppState();
    } catch (e) {
      toast(`Не удалось скачать: ${(e as Error).message}`, "err");
    }
    setBusy(false);
  };
  return (
    <div className="card firstrun">
      <div>
        <h3 className="h">Первый запуск: нужно скачать модель распознавания речи</h3>
        <p className="muted">Один раз, около 1,6 ГБ. Без неё запись сохранится, но разбор не построится. Распознавание потом работает на этом компьютере, без интернета.</p>
      </div>
      <div className="row">
        <button className="btn primary" onClick={download} disabled={busy}>{busy ? "Скачиваем… обычно 3–5 минут" : "Скачать"}</button>
        {!busy && <button className="btn ghost" onClick={() => setHidden(true)}>Позже</button>}
      </div>
    </div>
  );
}
