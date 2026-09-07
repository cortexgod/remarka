/**
 * Логотип: знак (реплика с волной голоса — тот же мотив, что в иконке приложения) и словесная марка.
 * Знак масштабируется от 16 до 96 px; словесная марка — Manrope 800 с плотной вёрсткой.
 */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M10 4h12a7 7 0 0 1 7 7v6a7 7 0 0 1-7 7h-9l-5 5.5V24a7 7 0 0 1-5-6.7V11a7 7 0 0 1 7-7z"
        fill="var(--accent)"
      />
      <g stroke="#fff" strokeWidth="2.6" strokeLinecap="round" fill="none">
        <path d="M10 11.5v5" />
        <path d="M14.5 2.5v23" />
        <path d="M19 9v10" />
        <path d="M23.5 11.5v5" />
      </g>
    </svg>
  );
}

export function Logo({ size = 26, text = true }: { size?: number; text?: boolean }) {
  return (
    <span className="logo" style={{ fontSize: Math.round(size * 0.68) }}>
      <LogoMark size={size} />
      {text && <span className="logo-text">Ремарка</span>}
    </span>
  );
}
