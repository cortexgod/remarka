import { HashRouter, NavLink, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useEffect } from "react";
import { StoreProvider, useStore } from "./lib/store";
import { isTauri } from "./lib/api";
import { fmtTime, plural } from "./lib/format";
import { Logo } from "./components/Logo";
import { Icon } from "./components/Icons";
import Feed from "./screens/Feed";
import Meeting from "./screens/Meeting";
import Progress from "./screens/Progress";
import Training from "./screens/Training";
import Prepare from "./screens/Prepare";
import Settings from "./screens/Settings";
import Overlay from "./screens/Overlay";
import Profile, { initials } from "./screens/Profile";
import Onboarding from "./screens/Onboarding";

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
  const broken = !!appState && !appState.engine_ok;
  return (
    <aside className="rail">
      <div className="rail-drag" data-tauri-drag-region />
      <div className="rail-brand">
        <Logo size={26} />
      </div>
      <nav>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="spacer" />
      {(rec || analyzing > 0 || broken || !isTauri) && (
        <div className="rail-foot">
          {rec ? (
            <div>
              <span className="dot rec" />
              запись {fmtTime(tick?.elapsed_sec ?? rec.elapsed_sec)}
            </div>
          ) : analyzing ? (
            <div>
              <span className="dot busy" />
              разбираем {analyzing} {plural(analyzing, "запись", "записи", "записей")}
            </div>
          ) : broken ? (
            <div>
              <span className="dot bad" />
              разбор недоступен
            </div>
          ) : (
            <div className="faint">демо‑данные</div>
          )}
        </div>
      )}
      <NavLink to="/profile" className={({ isActive }) => "rail-profile" + (isActive ? " active" : "")}>
        <span className="avatar">{initials(prof?.name ?? "")}</span>
        <span className="rail-profile-text">
          <span className="rail-profile-name">{prof?.name?.trim() || "Профиль"}</span>
          <span className="hint">{prof?.role?.trim() || "заполнить"}</span>
        </span>
      </NavLink>
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
