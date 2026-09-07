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

const NAV: { to: string; n: string; label: string }[] = [
  { to: "/", n: "01", label: "Лента" },
  { to: "/progress", n: "02", label: "Прогресс" },
  { to: "/training", n: "03", label: "Тренировка" },
  { to: "/prepare", n: "04", label: "Подготовка" },
  { to: "/settings", n: "05", label: "Настройки" },
];

function Rail() {
  const { appState, tick, meetings } = useStore();
  const rec = appState?.recording;
  const analyzing = meetings.filter((m) => m.status === "analyzing").length;
  return (
    <aside className="rail">
      <h1 className="brand">
        Ремарка <small>{isTauri ? "" : "mock"}</small>
      </h1>
      <nav>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
            <span className="n">{n.n}</span>
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="spacer" />
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
  return (
    <div className="shell">
      <Rail />
      <main className="page-root">
        <ScrollTop />
        <Routes>
          <Route path="/" element={<Feed />} />
          <Route path="/meeting/:id" element={<MeetingRoute />} />
          <Route path="/progress" element={<Progress />} />
          <Route path="/training" element={<Training />} />
          <Route path="/prepare" element={<Prepare />} />
          <Route path="/settings" element={<Settings />} />
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
