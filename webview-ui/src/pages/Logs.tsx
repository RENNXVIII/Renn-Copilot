import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { LogViewer } from "../components/LogViewer";

const POLL_MS = 3000;
const MAX_LINES = 3000; // client-side cap so a long-running session doesn't grow unbounded
const INITIAL_LOOKBACK_SECONDS = 300; // first fetch shows the last 5 minutes, not CLIProxyAPI's entire on-disk history

/**
 * CLIProxyAPI's GET /logs has no way to limit line count -- an `after`
 * timestamp is the only filter. Calling it with no `after` (as this used to
 * do every 3s) re-fetches the *entire* on-disk log every poll, which got
 * dramatically slower over a long session once logging-to-file was enabled
 * (the log only grows, never shrinks, until CLIProxyAPI restarts). This
 * seeds `after` with a recent timestamp on mount, then advances it to each
 * response's `latest-timestamp` so subsequent polls only fetch new lines.
 */
function useProxyLogTail(enabled: boolean) {
  const [lines, setLines] = useState<string[]>([]);
  const cursorRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    cursorRef.current = Math.floor(Date.now() / 1000) - INITIAL_LOOKBACK_SECONDS;
    setLines([]);
  }, [enabled]);

  usePolling(
    async () => {
      const result = await api.getProxyLogs(cursorRef.current);
      if (result["latest-timestamp"]) cursorRef.current = result["latest-timestamp"];
      if (result.lines?.length) {
        setLines((prev) => {
          const next = [...prev, ...result.lines];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      }
      return result;
    },
    POLL_MS,
    enabled
  );

  return lines;
}

export function Logs() {
  const [source, setSource] = useState<"backend" | "proxy">("proxy");
  const { data: own } = usePolling(api.getOwnLogs, POLL_MS, source === "backend");
  const proxyLines = useProxyLogTail(source === "proxy");

  const lines = source === "backend" ? own?.lines ?? [] : proxyLines;

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
        <div className="card-desc">
          {source === "proxy" ? `Most recent lines at the bottom (last ~${Math.round(INITIAL_LOOKBACK_SECONDS / 60)} minutes on load, then live).` : "Most recent lines at the bottom."}
        </div>
        <LogViewer lines={lines} downloadFilename={source === "proxy" ? "cliproxyapi-log.txt" : "backend-log.txt"} />
      </div>
    </div>
  );
}
