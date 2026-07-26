import { useCallback, useEffect, useMemo, useState } from "react";
import {
  requestRtk,
  type RtkScope,
  type RtkStatus,
  type RtkGainSummary,
  type RtkGainPeriod,
} from "../vscodeApi";

function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Compact token count (1.2K, 3.4M) for chart axes and dense KPIs. */
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

type ChartPeriod = "daily" | "weekly" | "monthly";

/** Shortens a period label to fit under a chart bar. */
function shortLabel(period: string, kind: ChartPeriod): string {
  if (!period) return "";
  if (kind === "daily") return period.slice(5); // MM-DD from YYYY-MM-DD
  if (kind === "monthly") return period.slice(2); // YY-MM from YYYY-MM
  return period.length > 6 ? period.slice(5) : period;
}

/**
 * Inline SVG chart: green bars for tokens saved per period, plus a line for the
 * savings percentage. No external chart dependency — reads only the gain data
 * RTK already returns.
 */
function SavingsChart({ rows, kind }: { rows: RtkGainPeriod[]; kind: ChartPeriod }) {
  const width = 520;
  const height = 120;
  const padTop = 10;
  const padBottom = 20;
  const padX = 4;
  const plotH = height - padTop - padBottom;

  const data = rows.slice(-14);
  if (data.length === 0) {
    return <div className="rtk-chart-empty">No activity recorded for this period yet.</div>;
  }

  const maxSaved = Math.max(1, ...data.map((d) => d.savedTokens));
  const slot = (width - padX * 2) / data.length;
  const barW = Math.max(2, Math.min(28, slot * 0.6));

  const linePoints = data
    .map((d, i) => {
      const cx = padX + slot * i + slot / 2;
      const cy = padTop + plotH - (Math.min(100, d.savingsPercent) / 100) * plotH;
      return `${cx.toFixed(1)},${cy.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg className="rtk-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img">
      {data.map((d, i) => {
        const barH = (d.savedTokens / maxSaved) * plotH;
        const x = padX + slot * i + (slot - barW) / 2;
        const y = padTop + plotH - barH;
        return (
          <g key={`${d.period}-${i}`}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(0, barH)}
              rx={2}
              fill="var(--vscode-charts-green, #4caf50)"
              opacity={0.8}
            >
              <title>{`${d.period}: ${formatNumber(d.savedTokens)} tokens saved (${d.savingsPercent.toFixed(1)}%)`}</title>
            </rect>
            <text
              x={padX + slot * i + slot / 2}
              y={height - 6}
              textAnchor="middle"
              fontSize="8"
              fill="var(--vscode-descriptionForeground)"
            >
              {shortLabel(d.period, kind)}
            </text>
          </g>
        );
      })}
      <polyline
        points={linePoints}
        fill="none"
        stroke="var(--vscode-charts-blue, #3794ff)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.9}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function Rtk() {
  const [status, setStatus] = useState<RtkStatus | null>(null);
  const [gain, setGain] = useState<RtkGainSummary | null>(null);
  const [scope, setScope] = useState<RtkScope>("global");
  const [chartPeriod, setChartPeriod] = useState<ChartPeriod>("daily");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const res = await requestRtk("getStatus");
    if (res.ok && res.status) {
      setStatus(res.status);
      setError(null);
    } else if (res.error) {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  const refreshGain = useCallback(async (s: RtkScope) => {
    const res = await requestRtk("refreshGain", s);
    if (res.ok && res.gain) setGain(res.gain);
    else setGain(null);
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.binary) void refreshGain(scope);
    else setGain(null);
  }, [status?.binary, scope, refreshGain]);

  async function act(action: "setup" | "uninstall" | "removeManaged") {
    setBusy(true);
    setError(null);
    try {
      const res = await requestRtk(action, action === "removeManaged" ? undefined : scope);
      if (res.status) setStatus(res.status);
      if (!res.ok && res.error) setError(res.error);
      if (res.ok && !res.cancelled && status?.binary) await refreshGain(scope);
    } finally {
      setBusy(false);
    }
  }

  const chartRows = useMemo(() => {
    if (!gain) return [];
    return gain[chartPeriod];
  }, [gain, chartPeriod]);

  if (loading) {
    return (
      <div className="page">
        <h1>RTK</h1>
        <p className="card-desc">Checking RTK status…</p>
      </div>
    );
  }

  if (status && !status.platformSupported) {
    return (
      <div className="page">
        <div>
          <h1>RTK</h1>
          <p className="page-hint">Rust Token Killer for GitHub Copilot.</p>
        </div>
        <div className="card">
          <div className="card-title">Unsupported platform</div>
          <div className="card-desc">
            {status.warning ?? "No official RTK release is available for this platform."}
          </div>
        </div>
      </div>
    );
  }

  const scopeStatus = status ? status[scope] : null;
  const binary = status?.binary ?? null;

  // A single, prioritized banner instead of stacked warning cards.
  let banner: { tone: "ok" | "warn" | "error"; title: string; desc: string } | null = null;
  if (error) {
    banner = { tone: "error", title: "Something went wrong", desc: error };
  } else if (status?.conflictPath) {
    banner = {
      tone: "warn",
      title: "Another `rtk` is on PATH",
      desc: `A different executable named "rtk" was found at ${status.conflictPath}. Renn will not modify it.`,
    };
  } else if (status?.restartRequired) {
    banner = {
      tone: "warn",
      title: "Restart required",
      desc: "RTK was added to your PATH but this session hasn't picked it up. Fully quit and reopen VS Code (not just Reload Window) so Copilot can resolve `rtk`.",
    };
  } else if (!binary && scopeStatus?.configured) {
    banner = {
      tone: "warn",
      title: "Binary missing",
      desc: `The Copilot hook for ${scope} is still configured, but the RTK binary was removed. Click "Enable for Copilot" to reinstall the managed binary, or "Disable" to remove the hook.`,
    };
  } else if (binary && scopeStatus?.configured) {
    const via = scopeStatus.hookPinned
      ? "via a pinned absolute path (no PATH needed)"
      : "on PATH";
    banner = {
      tone: "ok",
      title: "RTK is active",
      desc: `RTK ${binary.version} is enabled for Copilot (${scope}) ${via}.`,
    };
  }

  return (
    <div className="page">
      <div>
        <h1>RTK</h1>
        <p className="page-hint">
          RTK (Rust Token Killer) rewrites GitHub Copilot tool/bash output through an official PreToolUse hook to cut
          token usage. It is a short-lived CLI, not a background server.
        </p>
      </div>

      {banner && (
        <div className={`rtk-banner ${banner.tone}`}>
          <span className="rtk-banner-icon">
            {banner.tone === "ok" ? "✓" : banner.tone === "error" ? "✕" : "⚠"}
          </span>
          <div className="rtk-banner-body">
            <span className="rtk-banner-title">{banner.title}</span>
            <span className="rtk-banner-desc">{banner.desc}</span>
          </div>
        </div>
      )}

      <div className="btn-row">
        {(["global", "workspace"] as RtkScope[]).map((s) => (
          <button
            key={s}
            className={`btn ${scope === s ? "" : "secondary"}`}
            onClick={() => setScope(s)}
            disabled={busy}
          >
            {s === "global" ? "Global" : "Workspace"}
          </button>
        ))}
      </div>

      {/* Hero: savings KPIs + trend chart side by side. */}
      <div className="rtk-hero">
        <div className="card">
          <div className="card-title" style={{ justifyContent: "flex-start" }}>
            Token savings ({scope})
          </div>
          {gain ? (
            <div className="rtk-kpi-grid">
              <div>
                <div className="rtk-kpi-label">Tokens saved</div>
                <div className="rtk-kpi-value accent">{formatNumber(gain.savedTokens)}</div>
              </div>
              <div>
                <div className="rtk-kpi-label">Avg reduction</div>
                <div className="rtk-kpi-value">{gain.savingsPercent.toFixed(1)}%</div>
              </div>
              <div>
                <div className="rtk-kpi-label">Commands</div>
                <div className="rtk-kpi-value">{formatNumber(gain.totalCommands)}</div>
              </div>
              <div>
                <div className="rtk-kpi-label">Input tokens</div>
                <div className="rtk-kpi-value">{formatCompact(gain.inputTokens)}</div>
                <div className="rtk-kpi-sub">{formatNumber(gain.inputTokens)} total</div>
              </div>
            </div>
          ) : (
            <div className="card-desc">No analytics yet. Run some Copilot tools with RTK enabled.</div>
          )}
          <div className="card-desc">
            Percentages reflect reduction in Copilot tool/bash output that RTK processed — not your billing or
            subscription usage.
          </div>
        </div>

        <div className="card">
          <div className="rtk-chart-head">
            <div className="card-title" style={{ justifyContent: "flex-start" }}>
              Savings trend
            </div>
            <div className="rtk-seg">
              {(["daily", "weekly", "monthly"] as ChartPeriod[]).map((p) => (
                <button
                  key={p}
                  className={chartPeriod === p ? "active" : ""}
                  onClick={() => setChartPeriod(p)}
                >
                  {p === "daily" ? "Daily" : p === "weekly" ? "Weekly" : "Monthly"}
                </button>
              ))}
            </div>
          </div>
          {gain ? (
            <>
              <SavingsChart rows={chartRows} kind={chartPeriod} />
              <div className="rtk-chart-legend">
                <span className="rtk-legend-item">
                  <span
                    className="rtk-legend-swatch"
                    style={{ background: "var(--vscode-charts-green, #4caf50)" }}
                  />
                  Tokens saved
                </span>
                <span className="rtk-legend-item">
                  <span
                    className="rtk-legend-swatch"
                    style={{ background: "var(--vscode-charts-blue, #3794ff)" }}
                  />
                  Reduction %
                </span>
              </div>
            </>
          ) : (
            <div className="rtk-chart-empty">No trend data yet.</div>
          )}
        </div>
      </div>

      {/* Binary + Copilot integration details. */}
      <div className="card">
        <div className="card-title">
          Binary
          {binary ? (
            binary.pathReady ? (
              <span className="badge success">On PATH</span>
            ) : scopeStatus?.hookPinned ? (
              <span className="badge success">Active (pinned)</span>
            ) : (
              <span className="badge neutral">Not on PATH</span>
            )
          ) : (
            <span className="badge neutral">Not installed</span>
          )}
        </div>
        {binary ? (
          <dl className="rtk-meta-grid">
            <dt>Source</dt>
            <dd>{binary.source === "managed" ? "Managed by Renn" : "Found on PATH"}</dd>
            <dt>Version</dt>
            <dd>
              {binary.version}
              {status?.updateAvailable && status.latestVersion ? (
                <span className="badge warning" style={{ marginLeft: 8 }}>
                  update: {status.latestVersion}
                </span>
              ) : null}
            </dd>
            <dt>Enabled</dt>
            <dd>{scopeStatus?.configured ? `Yes (${scope})` : `No (${scope})`}</dd>
            <dt>Path</dt>
            <dd className="mono-ellipsis" title={binary.path}>
              {binary.path}
            </dd>
          </dl>
        ) : (
          <div className="card-desc">No RTK binary yet. Enabling RTK below will install a managed one.</div>
        )}

        <div className="btn-row">
          {!scopeStatus?.configured || !binary ? (
            <button className="btn" onClick={() => act("setup")} disabled={busy}>
              {busy ? "Working…" : !binary && scopeStatus?.configured ? `Reinstall & enable (${scope})` : `Enable for Copilot (${scope})`}
            </button>
          ) : null}
          {scopeStatus?.configured ? (
            <button className="btn secondary" onClick={() => act("uninstall")} disabled={busy}>
              {busy ? "Working…" : `Disable (${scope})`}
            </button>
          ) : null}
          {status?.updateAvailable && (
            <button className="btn secondary" onClick={() => act("setup")} disabled={busy}>
              Update binary
            </button>
          )}
          {binary?.source === "managed" && (
            <button className="btn btn-danger" onClick={() => act("removeManaged")} disabled={busy}>
              Delete managed binary
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
