import type { Settings } from "../types/contracts";

/** Тема: prefers-color-scheme по умолчанию; явный выбор — data-theme на <html>. */
export function applyTheme(theme: Settings["theme"] | undefined): void {
  const el = document.documentElement;
  if (!theme || theme === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", theme);
}
