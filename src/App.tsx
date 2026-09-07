import { HashRouter, NavLink, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useEffect } from "react";
import { StoreProvider, useStore } from "./lib/store";
import { isTauri } from "./lib/api";
import { fmtTime } from "./lib/format";
import Feed from "./screens/Feed";
import Meeting from "./screens/Meeting";
import Progress from "./screens/Progress";
import Training from "./screens/Training";
import Prepare from "./screens/Prepare";
import Settings from "./screens/Settings";
import Overlay from "./screens/Overlay";
import Profile, { initials } from "./screens/Profile";
import Onboarding from "./screens/Onboarding";

const ICONS: Record<string, string> = {
  feed: "M4 6h16M4 12h16M4 18h10",
  progress: "M4 19l5-7 4 4 7-9M4 19h16",
  training: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6",
  prepare: "M9 5h6M9 12h6M9 19h6M5 5h.01M5 12h.01M5 19h.01",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM3 12h2M19 12h2M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4",
};

function Icon({ d }: { d: string }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const NAV: { to: string; icon: string; label: string }[] = [
  { to: "/", icon: "feed", label: "Встречи" },
  { to: "/progress", icon: "progress", label: "Прогресс" },
  { to: "/training", icon: "training", label: "Тренировка" },
  { to: "/prepare", icon: "prepare", label: "Подготовка" },
  { to: "/settings", icon: "settings", label: "Настройки" },
];

function Rail() {
  const { appState, tick, meetings, settings } = useStore();
  const rec = appState?.recording;
  const prof = settings?.profile;
  const analyzing = meetings.filter((m) => m.status === "analyzing").length;
  return (
    <aside className="rail">
      <div className="rail-drag" data-tauri-drag-region />
      <h1 className="brand">
        Ремарка <small>{isTauri ? "" : "mock"}</small>
      </h1>
      <nav>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon d={ICONS[n.icon]} />
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="spacer" />
      <NavLink to="/profile" className={({ isActive }) => "rail-profile" + (isActive ? " active" : "")}>
        <span className="avatar">{initials(prof?.name ?? "")}</span>
        <span className="rail-profile-text">
          <span className="rail-profile-name">{prof?.name?.trim() || "Профиль"}</span>
          <span className="hint">{prof?.role?.trim() || "кто говорит"}</span>
        </span>
      </NavLink>
      <div className="rail-foot">
        {rec ? (
          <div>
            <span className="dot rec" />
            запись {fmtTime(tick?.elapsed_sec ?? rec.elapsed_sec)}
          </div>
        ) : analyzing ? (
          <div>
            <span className="dot" />
            анализ · {analyzing}
          </div>
        ) : (
          <div>
            <span className={"dot" + (appState && !appState.engine_ok ? " bad" : "")} />
            {appState ? (appState.engine_ok ? "движок готов" : "движок не найден") : "…"}
          </div>
        )}
      </div>
    </aside>
  );
}

function Toasts() {
  const { toasts } = useStore();
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={"toast" + (t.kind === "err" ? " err" : "")}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function ScrollTop() {
  const loc = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  return null;
}

function Shell() {
  const { settings } = useStore();
  if (settings && !settings.onboarding_done) return <Onboarding />;
  return (
    <div className="shell">
      <Rail />
      <main className="page-root">
        <div className="titlebar-drag" data-tauri-drag-region />
        <ScrollTop />
        <Routes>
          <Route path="/" element={<Feed />} />
          <Route path="/meeting/:id" element={<MeetingRoute />} />
          <Route path="/progress" element={<Progress />} />
          <Route path="/training" element={<Training />} />
          <Route path="/prepare" element={<Prepare />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Feed />} />
        </Routes>
      </main>
      <Toasts />
    </div>
  );
}

function Root() {
  const isOverlay = window.location.hash.startsWith("#/overlay");
  useEffect(() => {
    document.body.classList.toggle("overlay-body", isOverlay);
  }, [isOverlay]);
  return (
    <Routes>
      <Route path="/overlay" element={<Overlay />} />
      <Route path="*" element={<Shell />} />
    </Routes>
  );
}

/** Размонтировать экран разбора при смене id — иначе под новым заголовком мелькает старый отчёт. */
function MeetingRoute() {
  const { id = "" } = useParams();
  return <Meeting key={id} />;
}

export default function App() {
  return (
    <StoreProvider>
      <HashRouter>
        <Root />
      </HashRouter>
    </StoreProvider>
  );
}
