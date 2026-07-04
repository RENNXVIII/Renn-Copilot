import { useMemo, useState } from "react";
import { api, type ProviderModelUsage, type RecentUsageRecord, type UsageAccount, type UsageApiKey, type UsageBucket } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { MaskedEmail } from "../components/Modal";
import { useEmailReveal } from "../hooks/useEmailReveal";
import { TrendChart } from "../components/shared";

type SortKey = "provider" | "model" | "requests" | "input_tokens" | "output_tokens" | "total_tokens";

const SORTABLE_COLUMNS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: "provider", label: "Provider" },
  { key: "model", label: "Model" },
  { key: "requests", label: "Requests", right: true },
  { key: "input_tokens", label: "Input tokens", right: true },
  { key: "output_tokens", label: "Output tokens", right: true },
  { key: "total_tokens", label: "Total tokens", right: true },
];

const BUCKET_WINDOW_LABEL = "last ~3.3h";
const TOKEN_USAGE_DAYS = 7;

const PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  claude: { input: 3, output: 15 },
  anthropic: { input: 3, output: 15 },
  gemini: { input: 1.25, output: 5 },
  antigravity: { input: 1.25, output: 5 },
  codex: { input: 2, output: 8 },
  chatgpt: { input: 2, output: 8 },
  openai: { input: 2, output: 8 },
};
const DEFAULT_PRICING = { input: 1, output: 3 };

function ratesFor(provider: string) {
  const key = provider.toLowerCase();
  const match = Object.keys(PRICING_PER_MILLION).find((k) => key.includes(k));
  return match ? PRICING_PER_MILLION[match] : DEFAULT_PRICING;
}

function estimateCostUsd(rows: ProviderModelUsage[]): number {
  return rows.reduce((sum, r) => {
    const rates = ratesFor(r.provider);
    return sum + (r.input_tokens / 1_000_000) * rates.input + (r.output_tokens / 1_000_000) * rates.output;
  }, 0);
}

function formatUsd(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 1 ? 4 : 2 });
}

function formatNumber(n: number) {
  return n.toLocaleString("en-US");
}

function parseRetryAfter(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const asNum = typeof value === "number" ? value : Number(value);
  if (!Number.isNaN(asNum) && asNum > 0) return asNum > 1e12 ? asNum : asNum * 1000;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function formatResetIn(epochMs: number | null): string | null {
  if (epochMs === null) return null;
  const diffMs = epochMs - Date.now();
  if (diffMs <= 0) return "should be available now";
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `~${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `~${hours}h${remMins ? ` ${remMins}m` : ""}`;
}

function getHealth(usage: UsageAccount | UsageApiKey): { critical: boolean; reason: string } {
  const isAccount = "label" in usage;
  if (isAccount && usage.disabled) return { critical: true, reason: "Account is inactive" };
  if (isAccount && usage.unavailable) return { critical: true, reason: "CLIProxyAPI reports quota exceeded" };
  return { critical: false, reason: "Available" };
}

export function Usage() {
  const { data: status } = usePolling(api.getStatus, 4000);
  const serverRunning = status?.running ?? false;
  const { data, error } = usePolling(api.getUsage, 10000, serverRunning);
  const { data: tokenData, error: tokenError } = usePolling(() => api.getUsageTokens(TOKEN_USAGE_DAYS), 20000, serverRunning);
  const { revealed } = useEmailReveal();

  const [tableQuery, setTableQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("total_tokens");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const visibleRows = useMemo(() => {
    const rows = tokenData?.byProviderModel ?? [];
    const q = tableQuery.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => r.provider.toLowerCase().includes(q) || r.model.toLowerCase().includes(q)) : rows;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [tokenData?.byProviderModel, tableQuery, sortKey, sortDir]);

  const totalRequests = (data?.totals.success ?? 0) + (data?.totals.failed ?? 0);
  const successRate = totalRequests > 0 ? Math.round(((data?.totals.success ?? 0) / totalRequests) * 100) : null;

  return (
    <div className="page">
      <div>
        <h1>Usage</h1>
        <p className="page-hint">Request counts per account and API key, as tracked by CLIProxyAPI since it last started.</p>
      </div>

      {!serverRunning && <div className="empty-hint">CLIProxyAPI isn't running, so there's no usage data to show. Go to Overview and click Start first.</div>}
      {serverRunning && error && <div className="empty-hint">Couldn't load usage: {error.message}</div>}

      {serverRunning && (
        <div className="card">
          <div className="card-title">Token usage by provider & model</div>
          <div className="card-desc">
            Token counts as reported directly by each provider (last {TOKEN_USAGE_DAYS} days{tokenData ? `, out of ${tokenData.availableDays} day(s) stored` : ""}).
          </div>
          {tokenError && (
            <p className="card-desc" style={{ color: "var(--vscode-errorForeground)" }}>
              Couldn't load token usage: {tokenError.message}
            </p>
          )}
          {!tokenError && tokenData && tokenData.byProviderModel.length === 0 && (
            <p className="card-desc">No token usage recorded yet. This fills in a few minutes after requests start flowing.</p>
          )}
          {!tokenError && tokenData && tokenData.byProviderModel.length > 0 && (
            <>
              <div className="search-box" style={{ maxWidth: 260 }}>
                <input value={tableQuery} onChange={(e) => setTableQuery(e.target.value)} placeholder="Filter by provider or model..." />
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="usage-table">
                  <thead>
                    <tr>
                      {SORTABLE_COLUMNS.map((col) => (
                        <th key={col.key} className={col.right ? "right" : ""} onClick={() => toggleSort(col.key)}>
                          {col.label} {sortKey === col.key && (sortDir === "asc" ? "↑" : "↓")}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.length === 0 && (
                      <tr>
                        <td colSpan={SORTABLE_COLUMNS.length} style={{ textAlign: "center", padding: "12px 0" }}>
                          No rows match your filter.
                        </td>
                      </tr>
                    )}
                    {visibleRows.map((row) => (
                      <tr key={`${row.provider}::${row.model}`}>
                        <td>{row.provider}</td>
                        <td className="card-desc">{row.model}</td>
                        <td className="right">{formatNumber(row.requests)}</td>
                        <td className="right">{formatNumber(row.input_tokens)}</td>
                        <td className="right">{formatNumber(row.output_tokens)}</td>
                        <td className="right" style={{ fontWeight: 600 }}>
                          {formatNumber(row.total_tokens)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!tokenError && tokenData && tokenData.byProviderModel.length > 0 && (
            <div className="empty-hint">
              Estimated cost on a paid API key: <strong>{formatUsd(estimateCostUsd(tokenData.byProviderModel))}</strong>
              <br />
              Rough estimate from static public per-token rates -- not real billing data.
            </div>
          )}

          {!tokenError && tokenData && tokenData.byDay.length > 1 && (
            <div>
              <p className="card-desc">Daily total tokens</p>
              <TrendChart byDay={tokenData.byDay} />
            </div>
          )}

          {!tokenError && tokenData && tokenData.recent.length > 0 && (
            <details>
              <summary className="card-desc" style={{ cursor: "pointer" }}>
                Recent requests ({tokenData.recent.length})
              </summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                {tokenData.recent.slice(0, 20).map((r: RecentUsageRecord, i: number) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: "0.8em" }}>
                    <span className="card-desc">{r.timestamp ? new Date(r.timestamp).toLocaleString() : "unknown time"}</span>
                    <span>
                      {r.provider} / {r.model}
                    </span>
                    <span className={r.failed ? "" : "card-desc"} style={r.failed ? { color: "var(--vscode-errorForeground)" } : undefined}>
                      {r.failed ? "failed" : `${formatNumber(r.tokens.total_tokens ?? 0)} tok`}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {serverRunning && (
        <div className="grid">
          <KpiBlock label={`Total requests (${BUCKET_WINDOW_LABEL})`} value={String(totalRequests)} />
          <KpiBlock label="Successful" value={String(data?.totals.success ?? 0)} color="var(--vscode-testing-iconPassed, #4caf50)" />
          <KpiBlock label="Failed" value={String(data?.totals.failed ?? 0)} color="var(--vscode-testing-iconFailed, #f14c4c)" />
        </div>
      )}

      {serverRunning && successRate !== null && <p className="page-hint">Success rate: {successRate}% across all accounts and keys.</p>}

      {serverRunning && ((data?.accounts?.length ?? 0) > 0 || (data?.apiKeys?.length ?? 0) > 0) && (
        <div className="card">
          <div className="card-title">Health monitor</div>
          <div className="card-desc">Live auth status across every account & key.</div>
          <div className="grid">
            {data?.accounts?.map((a) => <HealthCard key={a.name} usage={a} revealed={revealed} />)}
            {data?.apiKeys?.map((k, i) => <HealthCard key={`${k.provider}-${i}`} usage={k} revealed={revealed} />)}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">OAuth accounts</div>
        <div className="card-desc">Per-account request counts. Manage logins on the Providers page.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {serverRunning && !data?.accounts?.length && <p className="card-desc">No accounts logged in yet.</p>}
          {data?.accounts?.map((a) => <UsageRow key={a.name} usage={a} revealed={revealed} />)}
        </div>
      </div>

      <div className="card">
        <div className="card-title">API keys</div>
        <div className="card-desc">Non-OAuth providers. Manage on the Providers page.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {serverRunning && !data?.apiKeys?.length && <p className="card-desc">No API keys configured yet.</p>}
          {data?.apiKeys?.map((k, i) => <UsageRow key={`${k.provider}-${i}`} usage={k} revealed={revealed} />)}
        </div>
      </div>
    </div>
  );
}

function KpiBlock({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="card">
      <div className="card-desc">{label}</div>
      <div className="kpi-value" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}

function HealthCard({ usage, revealed }: { usage: UsageAccount | UsageApiKey; revealed: boolean }) {
  const isAccount = "label" in usage;
  const { critical, reason } = getHealth(usage);
  const resetIn = isAccount ? formatResetIn(parseRetryAfter(usage.next_retry_after)) : null;
  return (
    <div className="health-row">
      <span className={`health-dot ${critical ? "bad" : "ok"}`} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="health-label">{isAccount ? <MaskedEmail email={usage.label} revealed={revealed} /> : usage.name || usage.keyMasked}</div>
        <div className="card-desc" style={critical ? { color: "var(--vscode-editorWarning-foreground)" } : undefined}>
          {reason}
          {resetIn && critical ? ` · resets ${resetIn}` : ""}
        </div>
      </div>
    </div>
  );
}

function UsageRow({ usage, revealed }: { usage: UsageAccount | UsageApiKey; revealed: boolean }) {
  const isAccount = "label" in usage;
  const subtitle = isAccount ? usage.provider : `${usage.provider}${usage.baseUrl ? ` · ${usage.baseUrl}` : ""}`;
  const resetIn = isAccount ? formatResetIn(parseRetryAfter(usage.next_retry_after)) : null;
  const total = usage.success + usage.failed;
  const successPct = total > 0 ? Math.round((usage.success / total) * 100) : null;
  const { critical } = getHealth(usage);

  return (
    <div className="cred-row" style={{ alignItems: "center" }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className={`health-dot ${critical ? "bad" : "ok"}`} />
          <span>{isAccount ? <MaskedEmail email={usage.label} revealed={revealed} /> : usage.keyMasked}</span>
          {isAccount && usage.disabled && <span className="badge neutral">Inactive</span>}
          {isAccount && usage.unavailable && (
            <span className="badge neutral">Quota exceeded{resetIn ? ` · resets ${resetIn}` : ""}</span>
          )}
        </div>
        <div className="cred-row-sub">{subtitle}</div>
        {total > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${successPct}%`, background: critical ? "var(--vscode-editorWarning-foreground, #cca700)" : "var(--vscode-testing-iconPassed, #4caf50)" }} />
            </div>
            <span className="card-desc">{successPct}%</span>
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ textAlign: "right" }}>
          <div>
            <span style={{ color: "var(--vscode-testing-iconPassed, #4caf50)" }}>{usage.success}</span>
            {" / "}
            <span style={usage.failed > 0 ? { color: "var(--vscode-errorForeground)" } : undefined}>{usage.failed}</span>
          </div>
          <div className="card-desc">ok / failed</div>
        </div>
        <Sparkline buckets={usage.recent_requests} />
      </div>
    </div>
  );
}

function Sparkline({ buckets }: { buckets: UsageBucket[] }) {
  if (!buckets?.length) return <span className="card-desc">No recent activity</span>;
  const max = Math.max(1, ...buckets.map((b) => b.success + b.failed));
  return (
    <div className="sparkline" title={`Request volume, ${BUCKET_WINDOW_LABEL}`}>
      {buckets.map((b, i) => {
        const total = b.success + b.failed;
        const barPct = total > 0 ? Math.max(8, (total / max) * 100) : 0;
        const successPct = total > 0 ? barPct * (b.success / total) : 0;
        const failedPct = total > 0 ? barPct * (b.failed / total) : 0;
        return (
          <div key={i} className="sparkline-bar" title={`${b.time}: ${b.success} ok, ${b.failed} failed`}>
            <div style={{ width: "100%", height: `${successPct}%`, background: "var(--vscode-testing-iconPassed, #4caf50)" }} />
            <div style={{ width: "100%", height: `${failedPct}%`, background: "var(--vscode-testing-iconFailed, #f14c4c)" }} />
          </div>
        );
      })}
    </div>
  );
}
