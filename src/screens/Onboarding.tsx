import { useEffect, useRef, useState } from "react";
import type { MeetingType, Profile } from "../types/contracts";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { GOAL_OPTIONS } from "../lib/metrics";
import { TYPE_LABELS } from "../lib/format";
import { Logo } from "../components/Logo";

const ROLES = ["Фаундер", "Продажи", "Руководитель", "Преподаватель", "Разработчик", "Маркетинг", "Консультант", "Студент"];
const MEETING_CHIPS: MeetingType[] = ["pitch", "demo", "sales", "interview", "standup", "lecture", "one_on_one"];

/**
 * Первый запуск: по одному вопросу на экран. Ответы складываются в профиль,
 * в конце — модель распознавания, если её ещё нет. Enter — дальше.
 */
export default function Onboarding() {
  const { settings, appState, updateSettings, run, refreshAppState, toast } = useStore();
  const [step, setStep] = useState(0);
  const [p, setP] = useState<Profile>({ name: "", role: "", about: "", goal_metric: null, typical_meetings: [] });
  const [systemAudio, setSystemAudio] = useState(false);
  const [dl, setDl] = useState<"idle" | "busy" | "done" | "skip">("idle");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (settings) {
      setP({ ...settings.profile, typical_meetings: settings.profile.typical_meetings ?? [] });
      setSystemAudio(settings.system_audio_default);
    }
  }, [settings]);
  useEffect(() => {
    inputRef.current?.focus();
  }, [step]);

  if (!settings) return null;
  const needModel = !!appState && !appState.asr_model_cached;
  const steps = ["name", "role", "meetings", "goal", "system", ...(needModel ? ["model"] : []), "done"] as const;
  const cur = steps[step];
  const last = step === steps.length - 1;
  const name = p.name.trim();

  const next = () => setStep((s) => Math.min(steps.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const finish = async () => {
    await run(updateSettings({ profile: { ...p, name, role: p.role.trim(), about: p.about.trim() }, system_audio_default: systemAudio, onboarding_done: true }));
  };
  const skipAll = async () => {
    await run(updateSettings({ onboarding_done: true }));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      if (last) finish();
      else next();
    }
  };
  const download = async () => {
    setDl("busy");
    try {
      await api.downloadModel(appState?.asr_model ?? "large-v3-turbo");
      setDl("done");
      refreshAppState();
    } catch (e) {
      toast(`Не удалось скачать: ${(e as Error).message}`, "err");
      setDl("idle");
    }
  };
  const toggleMeeting = (t: MeetingType) =>
    setP({ ...p, typical_meetings: p.typical_meetings.includes(t) ? p.typical_meetings.filter((x) => x !== t) : [...p.typical_meetings, t] });

  return (
    <div className="onb" onKeyDown={onKey}>
      <div className="onb-drag" data-tauri-drag-region />
      <div className="onb-card">
        <div className="onb-logo"><Logo size={30} /></div>
        <div className="onb-dots" aria-hidden="true">
          {steps.map((s, i) => <span key={s} className={i === step ? "on" : i < step ? "past" : ""} />)}
        </div>

        {cur === "name" && (
          <>
            <p className="onb-kicker">Давай знакомиться</p>
            <h1 className="onb-q">Как тебя зовут?</h1>
            <p className="onb-hint">Так к тебе будут обращаться в советах после встреч.</p>
            <input ref={inputRef} className="input onb-input" value={p.name} placeholder="Имя" onChange={(e) => setP({ ...p, name: e.target.value })} />
          </>
        )}

        {cur === "role" && (
          <>
            <h1 className="onb-q">{name ? `${name}, чем ты занимаешься?` : "Чем ты занимаешься?"}</h1>
            <p className="onb-hint">Можно выбрать или написать своими словами.</p>
            <div className="chips">
              {ROLES.map((r) => (
                <button key={r} type="button" className={"chip" + (p.role === r ? " on" : "")} onClick={() => setP({ ...p, role: r })}>{r}</button>
              ))}
            </div>
            <input ref={inputRef} className="input onb-input" value={p.role} placeholder="Например: продажи в B2B" onChange={(e) => setP({ ...p, role: e.target.value })} />
          </>
        )}

        {cur === "meetings" && (
          <>
            <h1 className="onb-q">Какие созвоны у тебя чаще всего?</h1>
            <p className="onb-hint">Можно несколько. Под тип встречи подстраиваются нормы: один и тот же темп хорош для демо и плох для лекции.</p>
            <div className="chips">
              {MEETING_CHIPS.map((t) => (
                <button key={t} type="button" className={"chip" + (p.typical_meetings.includes(t) ? " on" : "")} onClick={() => toggleMeeting(t)}>{TYPE_LABELS[t]}</button>
              ))}
            </div>
            <textarea className="textarea onb-area" value={p.about} placeholder="Пара слов о встречах: с кем говоришь, что для тебя важно. Необязательно." onChange={(e) => setP({ ...p, about: e.target.value })} />
          </>
        )}

        {cur === "goal" && (
          <>
            <h1 className="onb-q">Что хочешь улучшить в первую очередь?</h1>
            <p className="onb-hint">Советы после каждой встречи будут строиться вокруг этого.</p>
            <div className="chips col">
              <button type="button" className={"chip" + (p.goal_metric == null ? " on" : "")} onClick={() => setP({ ...p, goal_metric: null })}>Пока не знаю — пусть подскажет разбор</button>
              {GOAL_OPTIONS.map((g) => (
                <button key={g.key} type="button" className={"chip" + (p.goal_metric === g.key ? " on" : "")} onClick={() => setP({ ...p, goal_metric: g.key })}>{g.label}</button>
              ))}
            </div>
          </>
        )}

        {cur === "system" && (
          <>
            <h1 className="onb-q">Записывать собеседников?</h1>
            <p className="onb-hint">Тогда в разборе появятся доля твоей речи, перебивания и вопросы собеседника. Собеседники попадают в запись — предупреждай их об этом. Можно поменять перед любой записью.</p>
            <div className="chips col">
              <button type="button" className={"chip" + (!systemAudio ? " on" : "")} onClick={() => setSystemAudio(false)}>Только мой голос</button>
              <button type="button" className={"chip" + (systemAudio ? " on" : "")} onClick={() => setSystemAudio(true)} disabled={appState?.system_audio_supported === false}>Меня и собеседников</button>
            </div>
          </>
        )}

        {cur === "model" && (
          <>
            <h1 className="onb-q">Осталось скачать модель распознавания речи</h1>
            <p className="onb-hint">Один раз, около 1,6 ГБ. Потом всё считается на этом компьютере, без интернета.</p>
            <div className="row" style={{ marginTop: 6 }}>
              {dl === "done" ? (
                <span className="good">Готово, модель скачана.</span>
              ) : (
                <>
                  <button type="button" className="btn primary" onClick={download} disabled={dl === "busy"}>{dl === "busy" ? "Скачиваем… обычно 3–5 минут" : "Скачать сейчас"}</button>
                  {dl !== "busy" && <button type="button" className="btn ghost" onClick={() => { setDl("skip"); next(); }}>Позже</button>}
                </>
              )}
            </div>
          </>
        )}

        {cur === "done" && (
          <>
            <h1 className="onb-q">{name ? `Готово, ${name}!` : "Готово!"}</h1>
            <p className="onb-hint">
              Перед следующим созвоном нажми «Записать» или дождись подсказки, когда начнётся звонок в Zoom. Через пару минут после встречи откроется разбор: цифры, транскрипт и три правки с цитатами.
              Если хочется попробовать прямо сейчас — есть тренировка на 60 секунд.
            </p>
          </>
        )}

        <div className="onb-actions">
          <div className="row">
            {step > 0 && <button type="button" className="btn ghost" onClick={back}>Назад</button>}
          </div>
          <div className="row">
            {!last && <button type="button" className="btn ghost" onClick={skipAll}>Пропустить всё</button>}
            {last ? (
              <button type="button" className="btn primary" onClick={finish}>Начать</button>
            ) : (
              <button type="button" className="btn primary" onClick={next} disabled={cur === "name" && !name}>Дальше</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
