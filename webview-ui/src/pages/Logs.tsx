import { useState } from "react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { LogViewer } from "../components/LogViewer";

export function Logs() {
  const [source, setSource] = useState<"backend" | "proxy">("proxy");
  const { data: own } = usePolling(api.getOwnLogs, 3000, source === "backend");
  const { data: proxy } = usePolling(() => api.getProxyLogs(), 3000, source === "proxy");

  const lines = source === "backend" ? own?.lines ?? [] : proxy?.lines ?? [];

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1>Logs</h1>
          <p className="page-hint">Live tail, refreshed every few seconds.</p>
        </div>
        <div className="btn-row">
          <button className={`btn ${source === "proxy" ? "" : "secondary"}`} onClick={() => setSource("proxy")}>
            CLIProxyAPI
          </button>
          <button className={`btn ${source === "backend" ? "" : "secondary"}`} onClick={() => setSource("backend")}>
            Backend
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">{source === "proxy" ? "CLIProxyAPI request log" : "Backend process log"}</div>
        <div className="card-desc">Most recent lines at the bottom.</div>
        <LogViewer lines={lines} downloadFilename={source === "proxy" ? "cliproxyapi-log.txt" : "backend-log.txt"} />
      </div>
    </div>
  );
}
