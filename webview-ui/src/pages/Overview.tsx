import { useEffect, useState } from "react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { useEmailReveal } from "../hooks/useEmailReveal";
import { KpiCard, HealthRow, TrendChart, Checklist } from "../components/shared";
import { postSyncModels } from "../vscodeApi";

const TOKEN_USAGE_DAYS = 7;

export function Overview({ onNavigate }: { onNavigate: (page: string) => void }) {
    const { data: status, mutate: refreshStatus } = usePolling(api.getStatus, 4000);
    const [busy, setBusy] = useState<string | null>(null);
    const [busyElapsed, setBusyElapsed] = useState(0);
    const { revealed } = useEmailReveal();

    // Install/update is a single blocking call that can take minutes on a slow
    // connection (downloading CLIProxyAPI's ~45MB binary) -- with no feedback
    // beyond a static "Installing..." label, a genuinely slow-but-working
    // download is indistinguishable from a hung one. Tail the backend's own
    // process log (which gets a line the instant each phase starts, e.g.
    // "Downloading CLIProxyAPI vX...") and show elapsed time so it's clear
    // something is actually happening.
    const { data: ownLogs } = usePolling(api.getOwnLogs, 1500, busy === "install");
    const lastLogLine = ownLogs?.lines?.[ownLogs.lines.length - 1];

    useEffect(() => {
        if (busy === null) {
            setBusyElapsed(0);
            return;
        }
        const start = Date.now();
        const id = setInterval(() => setBusyElapsed(Math.round((Date.now() - start) / 1000)), 1000);
        return () => clearInterval(id);
    }, [busy]);

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
            // Starting/stopping the server changes what should be in Copilot
            // chat -- nudge the extension to reconcile chatLanguageModels.json
            // now instead of waiting for its periodic status poll.
            if (action === "start" || action === "stop" || action === "restart") {
                postSyncModels();
            }
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
                            <div className="card-desc">Installed version</div>
                            <div>{status?.binaryInstalled ? (status.installedVersion ? `v${status.installedVersion}` : "Unknown") : "Not installed"}</div>
                        </div>
                        <div>
                            <div className="card-desc">Latest GitHub version</div>
                            <div>
                                {status?.latestVersion ? (
                                    <span>v{status.latestVersion}</span>
                                ) : (
                                    "Unavailable"
                                )}
                            </div>
                        </div>
                        <div>
                            <div className="card-desc">Version status</div>
                            <div>
                                {!status?.binaryInstalled
                                    ? "Binary not installed"
                                    : !status.installedVersion || !status.latestVersion
                                        ? "Comparison unavailable"
                                        : (
                                            <span className={`badge ${status.updateAvailable ? "error" : "success"}`}>
                                                {status.updateAvailable ? "Update available" : "Up to date"}
                                            </span>
                                        )}
                            </div>
                        </div>
                        <div>
                            <div className="card-desc">Last error</div>
                            <div>{status?.lastStartError ?? "None"}</div>
                        </div>
                    </div>
                    <div className="btn-row">
                        <button className="btn secondary" disabled={busy !== null} onClick={() => run("install", api.install)}>
                            {busy === "install"
                                ? `${status?.binaryInstalled ? "Updating" : "Installing"}... (${busyElapsed}s)`
                                : status?.binaryInstalled
                                    ? "Update version"
                                    : "Install binary"}
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
                    {busy === "install" && (
                        <p className="card-desc" style={{ marginTop: 6 }}>
                            {lastLogLine ? lastLogLine.replace(/^\[[^\]]+\]\s*/, "") : "Starting install..."}
                        </p>
                    )}
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
                                <HealthRow key={a.name} usage={a} revealed={revealed} />
                            ))}
                            {(usage?.apiKeys ?? []).slice(0, Math.max(0, 4 - (usage?.accounts?.length ?? 0))).map((k, i) => (
                                <HealthRow key={`${k.provider}-${i}`} usage={k} revealed={revealed} />
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
