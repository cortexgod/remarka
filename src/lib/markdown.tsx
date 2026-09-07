import type { ReactNode } from "react";

/** Минимальный markdown: заголовки, списки, абзацы, **жирный**. Без внешних библиотек. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split(/\r?\n/);
  let list: string[] = [];
  let para: string[] = [];
  const flushList = () => {
    if (list.length) blocks.push(<ul key={`ul${blocks.length}`}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    list = [];
  };
  const flushPara = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(" "))}</p>);
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushList();
      flushPara();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      flushPara();
      const lvl = h[1].length;
      const content = inline(h[2]);
      blocks.push(lvl === 1 ? <h1 key={`h${blocks.length}`}>{content}</h1> : lvl === 2 ? <h2 key={`h${blocks.length}`}>{content}</h2> : <h3 key={`h${blocks.length}`}>{content}</h3>);
      continue;
    }
    const li = /^[-*•]\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      list.push(li[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushList();
  flushPara();
  return <div className={"md" + (className ? " " + className : "")}>{blocks}</div>;
}

function inline(s: string): ReactNode {
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>));
}
