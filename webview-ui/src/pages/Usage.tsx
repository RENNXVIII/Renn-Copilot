import { useMemo, useState } from "react";
import { api, type ProviderModelUsage, type RecentUsageRecord } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { TrendChart } from "../components/shared";
import { ratesFor, formatUsd, formatNumber } from "../lib/utils";
import { AuthFilesTable } from "../components/AuthFilesTable";

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

function estimateCostUsd(rows: ProviderModelUsage[]): number {
  return rows.reduce((sum, r) => {
    const rates = ratesFor(r.provider);
    return sum + (r.input_tokens / 1_000_000) * rates.input + (r.output_tokens / 1_000_000) * rates.output;
  }, 0);
}

export function Usage() {
  const { data: status } = usePolling(api.getStatus, 4000);
  const serverRunning = status?.running ?? false;
  const { data, error } = usePolling(api.getUsage, 10000, serverRunning);
  const { data: tokenData, error: tokenError } = usePolling(() => api.getUsageTokens(TOKEN_USAGE_DAYS), 20000, serverRunning);

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

      {serverRunning && <AuthFilesTable />}

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

