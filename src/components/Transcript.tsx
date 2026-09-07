import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { OtherUtterance, Report, Sentence, SpeechEvent, Word } from "../types/contracts";
import { fmtNum, fmtTime } from "../lib/format";

export interface Highlight {
  fillers: boolean;
  crutches: boolean;
  pauses: boolean;
  prosody: boolean;
}

interface Props {
  report: Report;
  time: number;
  playing: boolean;
  /** увеличивается при каждом seek — команда прокрутить к слову */
  seekSerial: number;
  onSeek: (t: number, andPlay?: boolean) => void;
  highlight: Highlight;
}

type Block = { kind: "me"; s: Sentence } | { kind: "other"; u: OtherUtterance; idx: number };

function findActiveWord(words: Word[], t: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function Transcript({ report, time, playing, seekSerial, onSeek, highlight }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const words = report.transcript.words;

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = report.transcript.sentences.map((s) => ({ kind: "me", s }));
    report.transcript.other.forEach((u, idx) => out.push({ kind: "other", u, idx }));
    return out.sort((a, b) => (a.kind === "me" ? a.s.start : a.u.start) - (b.kind === "me" ? b.s.start : b.u.start));
  }, [report]);

  // события по предложениям
  const evBySentence = useMemo(() => {
    const m = new Map<number, SpeechEvent[]>();
    for (const e of report.events) {
      if (e.sentence_i == null) continue;
      if (!m.has(e.sentence_i)) m.set(e.sentence_i, []);
      m.get(e.sentence_i)!.push(e);
    }
    return m;
  }, [report]);

  const active = findActiveWord(words, time);
  const activeSentence = active >= 0 ? words[active].sentence_i : -1;

  // прокрутка к слову при seek
  useEffect(() => {
    if (seekSerial === 0) return;
    scrollToWord(box.current, active, "auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekSerial]);

  // следование за воспроизведением
  useEffect(() => {
    if (!playing || !follow || active < 0) return;
    const el = box.current?.querySelector<HTMLElement>(`#w-${active}`);
    const c = box.current;
    if (!el || !c) return;
    const top = el.offsetTop - c.scrollTop;
    if (top < 40 || top > c.clientHeight - 60) scrollToWord(c, active, "smooth");
  }, [active, playing, follow]);

  return (
    <div className="transcript">
      <div className="tr-head">
        <span className="label">Транскрипт · {report.metrics.layer1.words_total.value ?? words.length} слов</span>
        <label className="check" style={{ fontSize: 12.5 }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> следовать за записью
        </label>
      </div>
      <div className="tr-body" ref={box}>
        {blocks.map((b) =>
          b.kind === "me" ? (
            <SentenceView
              key={"s" + b.s.i}
              s={b.s}
              words={words}
              events={evBySentence.get(b.s.i)}
              activeWord={activeSentence === b.s.i ? active : -1}
              onSeek={onSeek}
              highlight={highlight}
            />
          ) : (
            <OtherView key={"o" + b.idx} u={b.u} onSeek={onSeek} active={time >= b.u.start && time < b.u.end} />
          ),
        )}
      </div>
    </div>
  );
}

function scrollToWord(c: HTMLDivElement | null, i: number, behavior: ScrollBehavior) {
  if (!c || i < 0) return;
  const el = c.querySelector<HTMLElement>(`#w-${i}`);
  if (!el) return;
  c.scrollTo({ top: Math.max(0, el.offsetTop - c.clientHeight / 2), behavior });
}

const SentenceView = memo(function SentenceView({
  s, words, events, activeWord, onSeek, highlight,
}: {
  s: Sentence;
  words: Word[];
  events: SpeechEvent[] | undefined;
  activeWord: number;
  onSeek: (t: number, andPlay?: boolean) => void;
  highlight: Highlight;
}) {
  const before = new Map<number, SpeechEvent[]>();
  const tail: SpeechEvent[] = [];
  for (const e of events ?? []) {
    if (e.kind === "hesitation_pause" && e.word_i != null) {
      if (!before.has(e.word_i)) before.set(e.word_i, []);
      before.get(e.word_i)!.push(e);
    } else if (e.kind === "structural_pause" || (e.kind === "filled_pause" && e.word_i == null) || e.kind === "rising_statement" || e.kind === "decay") {
      tail.push(e);
    }
  }
  const items = [];
  for (let i = s.word_from; i <= s.word_to; i++) {
    const w = words[i];
    const pre = before.get(i);
    if (pre && highlight.pauses) for (const e of pre) items.push(<span key={"p" + i} className="pause hes" title="хезитационная пауза внутри фразы">{e.value != null ? `${fmtNum(e.value, 1)} с` : e.label}</span>);
    const cls = ["w"];
    if (w.kind === "filler" && highlight.fillers) cls.push("w-filler");
    if (w.kind === "crutch" && highlight.crutches) cls.push("w-crutch");
    if (i === activeWord) cls.push("w-active");
    items.push(
      <span key={i} id={`w-${i}`} className={cls.join(" ")} onClick={() => onSeek(w.start, true)} title={w.kind === "filler" ? "заполненная пауза" : w.kind === "crutch" ? "слово‑костыль" : undefined}>
        {w.text}
      </span>,
    );
    items.push(" ");
  }
  return (
    <p className={"sent" + (activeWord >= 0 ? " sent-active" : "")}>
      <button className="tc" onClick={() => onSeek(s.start, true)} title="Перейти к моменту">
        {fmtTime(s.start)}
      </button>
      <span className="sent-text">
        {items}
        {tail.map((e, k) => {
          if (e.kind === "structural_pause" && highlight.pauses) return <span key={k} className="pause str" title="структурная пауза на границе мысли">{e.value != null ? `${fmtNum(e.value, 1)} с` : e.label}</span>;
          if (e.kind === "filled_pause" && highlight.fillers) return <span key={k} className="w w-filler w-det" title="заполненная пауза (детектор по сигналу)">{e.label}</span>;
          if (e.kind === "rising_statement" && highlight.prosody) return <span key={k} className="pro up" title="восходящий тон в утверждении">↗ {e.label}</span>;
          if (e.kind === "decay" && highlight.prosody) return <span key={k} className="pro down" title="затухание к концу фразы">↘ {e.label}</span>;
          return null;
        })}
      </span>
    </p>
  );
});

const OtherView = memo(function OtherView({ u, onSeek, active }: { u: OtherUtterance; onSeek: (t: number, andPlay?: boolean) => void; active: boolean }) {
  return (
    <div className={"other" + (active ? " other-active" : "")}>
      <button className="tc" onClick={() => onSeek(u.start, true)}>
        {fmtTime(u.start)}
      </button>
      <div>
        <span className="label" style={{ color: "var(--signal-ink)" }}>
          собеседник{u.is_question ? " · вопрос" : ""}
        </span>
        <p className="other-text">{u.text}</p>
      </div>
    </div>
  );
});
