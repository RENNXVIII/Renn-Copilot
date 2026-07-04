import { useEffect, useState } from "react";
import { Overview } from "./pages/Overview";
import { Models } from "./pages/Models";
import { Providers } from "./pages/Providers";
import { Usage } from "./pages/Usage";
import { Logs } from "./pages/Logs";
import { Config } from "./pages/Config";

const PAGES = [
  { id: "overview", label: "Overview" },
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" },
  { id: "usage", label: "Usage" },
  { id: "logs", label: "Logs" },
  { id: "config", label: "Config" },
] as const;

type PageId = (typeof PAGES)[number]["id"];

function isPageId(value: unknown): value is PageId {
  return PAGES.some((p) => p.id === value);
}

declare global {
  interface Window {
    __RENN_INITIAL_PAGE__?: string | null;
  }
}

export function App() {
  const [page, setPage] = useState<PageId>(() => (isPageId(window.__RENN_INITIAL_PAGE__) ? window.__RENN_INITIAL_PAGE__ : "overview"));

  // The sidebar's quick links (e.g. "6/11 enabled" -> Models) postMessage a
  // "navigate" command when this panel is already open, since there's no
  // page reload to re-read window.__RENN_INITIAL_PAGE__ in that case.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.data?.command === "navigate" && isPageId(event.data.page)) {
        setPage(event.data.page);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <>
      <nav className="app-nav">
        {PAGES.map((p) => (
          <button key={p.id} className={page === p.id ? "active" : ""} onClick={() => setPage(p.id)}>
            {p.label}
          </button>
        ))}
      </nav>
      {page === "overview" && <Overview onNavigate={(p) => setPage(p as PageId)} />}
      {page === "providers" && <Providers />}
      {page === "models" && <Models />}
      {page === "usage" && <Usage />}
      {page === "logs" && <Logs />}
      {page === "config" && <Config />}
    </>
  );
}
