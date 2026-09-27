import { useEffect, useState } from "react";
import { Overview } from "./pages/Overview";
import { Models } from "./pages/Models";
import { Providers } from "./pages/Providers";
import { Usage } from "./pages/Usage";
import { Neuron } from "./pages/Neuron";
import { Logs } from "./pages/Logs";
import { Config } from "./pages/Config";
import { Rtk } from "./pages/Rtk";
import { Ponytail } from "./pages/Ponytail";
import { Skills } from "./pages/Skills";
import { toolTabForPage, type ToolTab } from "./lib/tools-navigation";

const PAGES = [
  { id: "overview", label: "Overview" },
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" },
  { id: "usage", label: "Usage" },
  { id: "tools", label: "Tools" },
  { id: "skills", label: "Skills" },
  { id: "neuron", label: "Activity" },
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
  const [page, setPage] = useState<PageId>(() => {
    const initial = window.__RENN_INITIAL_PAGE__;
    return toolTabForPage(initial) ? "tools" : isPageId(initial) ? initial : "overview";
  });
  const [toolTab, setToolTab] = useState<ToolTab>(() => toolTabForPage(window.__RENN_INITIAL_PAGE__) ?? "rtk");

  // The sidebar's quick links (e.g. "6/11 enabled" -> Models) postMessage a
  // "navigate" command when this panel is already open, since there's no
  // page reload to re-read window.__RENN_INITIAL_PAGE__ in that case.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.data?.command === "navigate") {
        const tab = toolTabForPage(event.data.page);
        if (tab) {
          setToolTab(tab);
          setPage("tools");
        } else if (isPageId(event.data.page)) {
          setPage(event.data.page);
        }
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
      {page === "tools" && (
        <>
          <nav className="tools-nav" aria-label="Tools tabs">
            {(["rtk", "ponytail"] as const).map((tab) => (
              <button key={tab} type="button" className={toolTab === tab ? "active" : ""} aria-current={toolTab === tab ? "page" : undefined} onClick={() => setToolTab(tab)}>
                {tab === "rtk" ? "RTK" : "Ponytail"}
              </button>
            ))}
          </nav>
          {toolTab === "rtk" ? <Rtk /> : <Ponytail />}
        </>
      )}
      {page === "skills" && <Skills />}
      {page === "neuron" && <Neuron />}
      {page === "logs" && <Logs />}
      {page === "config" && <Config />}
    </>
  );
}
