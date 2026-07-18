import { useState } from "react";
import { api } from "./api/client";
import { usePolling } from "./hooks/usePolling";
import { postOpenDashboardPanel, postSyncModels, postCopyApiKey } from "./vscodeApi";

/**
 * Compact Activity Bar sidebar view -- status + the handful of actions
 * actually worth one click away, not a squeezed-down copy of the full
 * dashboard (that's what "Open Full Dashboard" is for). See App.tsx for the
 * full tabbed experience this complements.
 */
export function Sidebar() {
    const { data: status, mutate: refreshStatus } = usePolling(api.getStatus, 4000);
    const serverRunning = status?.running ?? false;
    const { data: usage } = usePolling(api.getUsage, 10000, serverRunning);
    const { data: models } = usePolling(api.getModels, 15000, serverRunning);
    const [busy, setBusy] = useState<string | null>(null);

    async function run(action: string, fn: () => Promise<unknown>) {
        setBusy(action);
        try {
            await fn();
        } catch {
            // Surfaced via the "Last error" field below on the next status poll.
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

    return (
        <div className="page" style={{ padding: 12, gap: 12 }}>
            <div className="card">
                <div className="card-title">
                    <span>CLIProxyAPI</span>
                    <span className={`badge ${status?.running ? "success" : "neutral"}`}>{status?.running ? "Running" : "Stopped"}</span>
                </div>
                {status?.lastStartError && (
                    <div className="card-desc" style={{ color: "var(--vscode-errorForeground)" }}>
                        <strong>Last error:</strong> {status.lastStartError}
                    </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {!status?.binaryInstalled && (
                        <button className="btn secondary" disabled={busy !== null} onClick={() => run("install", api.install)}>
                            {busy === "install" ? "Installing..." : "Install binary"}
                        </button>
                    )}
                    {status?.binaryInstalled && status.updateAvailable && (
                        <button className="btn secondary" disabled={busy !== null} onClick={() => run("install", api.install)}>
                            {busy === "install" ? "Updating..." : "Update version"}
                        </button>
                    )}
                    <button className="btn" disabled={busy !== null || status?.running} onClick={() => run("start", api.start)}>
                        {busy === "start" ? "Starting..." : "Start"}
                    </button>
                    <button className="btn secondary" disabled={busy !== null || !status?.running} onClick={() => run("stop", api.stop)}>
                        {busy === "stop" ? "Stopping..." : "Stop"}
                    </button>
                    <button className="btn secondary" disabled={busy !== null} onClick={() => run("restart", api.restart)}>
                        {busy === "restart" ? "Restarting..." : "Restart"}
                    </button>
                </div>
            </div>

            <div className="card">
                <div className="card-title">Health</div>
                {!serverRunning && <p className="card-desc">Server isn't running.</p>}
                {serverRunning && credentials.length === 0 && <p className="card-desc">No accounts or API keys connected yet.</p>}
                {serverRunning && credentials.length > 0 && (
                    <p style={{ margin: 0 }}>
                        🟢 {availableCount}
                        {unavailableCount > 0 ? `  🔴 ${unavailableCount}` : ""}
                    </p>
                )}
            </div>

            <div className="card">
                <div className="card-title">Models</div>
                {!serverRunning && <p className="card-desc">Server isn't running.</p>}
                {serverRunning && (
                    <p style={{ margin: 0 }}>
                        {totalModels ? `${enabledModels}/${totalModels}` : "-"} <span className="card-desc">enabled</span>
                    </p>
                )}
                <a className="link" onClick={() => postOpenDashboardPanel("models")}>
                    Manage models
                </a>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <button className="btn secondary" onClick={postSyncModels}>
                    Sync Models
                </button>
                <button className="btn secondary" onClick={postCopyApiKey}>
                    Copy API Key
                </button>
                <button className="btn" onClick={() => postOpenDashboardPanel()}>
                    Open Full Dashboard
                </button>
            </div>
        </div>
    );
}
