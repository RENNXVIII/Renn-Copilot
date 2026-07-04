import { useState } from "react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { KpiCard, HealthRow, TrendChart, Checklist } from "../components/shared";

const TOKEN_USAGE_DAYS = 7;

export function Overview({ onNavigate }: { onNavigate: (page: string) => void }) {
  const { data: status, mutate: refreshStatus } = usePolling(api.getStatus, 4000);
  const [busy, setBusy] = useState<string | null>(null);

  const serverRunning = status?.running ?? false;
  const { data: models } = usePolling(api.getModels, 15000, serverRunning);
  const { data: usage } = usePolling(api.getUsage, 10000, serverRunning);
  const { data: tokenData } = usePolling(() => api.getUsageTokens(TOKEN_USAGE_DAYS), 20000, serverRunning);

  async function run(action: string, fn: () => Promise<unknown>) {
    setBusy(action);
    try {
      await fn();
    } catch {
      // Surfaced via the "Last error" field in the card below on next status poll.
    } finally {
      setBusy(null);
      refreshStatus(undefined, true);
    }
  }

  const credentials = [...(usage?.accounts ?? []), ...(usage?.apiKeys ?? [])];
  const unavailableCount = (usage?.accounts ?? []).filter((a) => a.disabled || a.unavailable).length;
  const availableCount = credentials.length - unavailableCount;

  const enabledModels = models?.models.filter((m) => m.enabled).length ?? 0;
  const totalModels = models?.models.length ?? 0;

  const totalRequests = (usage?.totals.success ?? 0) + (usage?.totals.failed ?? 0);
  const successRate = totalRequests > 0 ? Math.round(((usage?.totals.success ?? 0) / totalRequests) * 100) : null;

  const checklist = [
    { label: "Binary installed", done: !!status?.binaryInstalled },
    { label: "Server running", done: serverRunning },
    { label: "At least 1 account/API key connected", done: credentials.length > 0 },
    { label: "At least 1 model enabled", done: enabledModels > 0 },
  ];

  return (
    <div className="page">
      <div>
        <h1>Overview</h1>
        <p className="page-hint">Server, accounts, and models at a glance.</p>
      </div>

      <div className="grid">
        <KpiCard
          label="Accounts & API keys"
          value={credentials.length ? `${availableCount}/${credentials.length}` : "-"}
          hint={credentials.length ? "available / total" : "Nothing connected yet"}
          warning={unavailableCount > 0}
          onClick={() => onNavigate("providers")}
        />
        <KpiCard
          label="Active models"
          value={totalModels ? `${enabledModels}/${totalModels}` : "-"}
          hint={totalModels ? "enabled / total" : "Server isn't running"}
          onClick={() => onNavigate("models")}
        />
        <KpiCard
          label="Requests (last ~3.3h)"
          value={totalRequests ? String(totalRequests) : "-"}
          hint={successRate !== null ? `${successRate}% success` : "No data yet"}
          warning={successRate !== null && successRate < 90}
          onClick={() => onNavigate("usage")}
        />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "2fr 1fr" }}>
        <div className="card">
          <div className="card-title">
            <span>CLIProxyAPI server</span>
            <span className={`badge ${status?.running ? "success" : "neutral"}`}>
              {status?.running ? "Running" : "Stopped"}
            </span>
          </div>
          <div className="card-desc">{status?.home ?? "-"}</div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div>
              <div className="card-desc">Binary installed</div>
              <div>{status?.binaryInstalled ? "Yes" : "No"}</div>
            </div>
            <div>
              <div className="card-desc">Last error</div>
              <div>{status?.lastStartError ?? "None"}</div>
            </div>
          </div>
          <div className="btn-row">
            <button className="btn secondary" disabled={busy !== null} onClick={() => run("install", api.install)}>
              {busy === "install" ? "Installing..." : "Install / Update binary"}
            </button>
            <button className="btn" disabled={busy !== null || status?.running} onClick={() => run("start", api.start)}>
              {busy === "start" ? "Starting..." : "Start"}
            </button>
            <button
              className="btn secondary"
              disabled={busy !== null || !status?.running}
              onClick={() => run("stop", api.stop)}
            >
              {busy === "stop" ? "Stopping..." : "Stop"}
            </button>
            <button className="btn secondary" disabled={busy !== null} onClick={() => run("restart", api.restart)}>
              {busy === "restart" ? "Restarting..." : "Restart"}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Setup checklist</div>
          <div className="card-desc">
            {checklist.filter((c) => c.done).length}/{checklist.length} done
          </div>
          <Checklist items={checklist} />
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="card">
          <div className="card-title">Health monitor</div>
          <div className="card-desc">Account & API key status at a glance.</div>
          {!serverRunning && <p className="card-desc">Server isn't running, so there's no account health data.</p>}
          {serverRunning && credentials.length === 0 && <p className="card-desc">No accounts or API keys connected yet.</p>}
          {serverRunning && credentials.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {(usage?.accounts ?? []).slice(0, 4).map((a) => (
                <HealthRow key={a.name} usage={a} />
              ))}
              {(usage?.apiKeys ?? []).slice(0, Math.max(0, 4 - (usage?.accounts?.length ?? 0))).map((k, i) => (
                <HealthRow key={`${k.provider}-${i}`} usage={k} />
              ))}
            </div>
          )}
          {serverRunning && credentials.length > 4 && (
            <a className="link" onClick={() => onNavigate("usage")}>
              View all ({credentials.length})
            </a>
          )}
        </div>

        <div className="card">
          <div className="card-title">Token usage ({TOKEN_USAGE_DAYS}d)</div>
          <div className="card-desc">Total tokens per day, as reported directly by each provider.</div>
          {!serverRunning && <p className="card-desc">Server isn't running.</p>}
          {serverRunning && (!tokenData || tokenData.byDay.length === 0) && <p className="card-desc">No token usage data yet.</p>}
          {serverRunning && tokenData && tokenData.byDay.length === 1 && (
            <p className="card-desc">Only 1 day recorded so far -- check back tomorrow for a trend.</p>
          )}
          {serverRunning && tokenData && tokenData.byDay.length > 1 && <TrendChart byDay={tokenData.byDay} />}
          {serverRunning && tokenData && (
            <a className="link" onClick={() => onNavigate("usage")}>
              View detail by provider & model
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
