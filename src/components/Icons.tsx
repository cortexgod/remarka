import type { ReactNode } from "react";

/** Иконки навигации: 24×24, обводка 1.75, скруглённые концы. */
const PATHS: Record<string, ReactNode> = {
  feed: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2.2" />
      <rect x="3" y="13" width="18" height="7" rx="2.2" />
    </>
  ),
  progress: (
    <>
      <path d="M3 17l5.5-5.5 4 4L20 7" />
      <path d="M14.5 7H20v5.5" />
    </>
  ),
  training: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" />
    </>
  ),
  prepare: (
    <>
      <rect x="4" y="3.5" width="16" height="17" rx="2.5" />
      <path d="M8.5 12.5l2.5 2.5 5-5.5" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h8.5M17.5 7H20M4 17h3.5M12.5 17H20" />
      <circle cx="15" cy="7" r="2.3" />
      <circle cx="10" cy="17" r="2.3" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
    </>
  ),
  play: <path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none" />,
  pause: <path d="M8 5v14M16 5v14" strokeWidth="2.4" />,
  back: <path d="M14 6l-6 6 6 6" />,
  folder: <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
};

export function Icon({ name, size = 18, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg
      className={"ic " + (className ?? "")}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
