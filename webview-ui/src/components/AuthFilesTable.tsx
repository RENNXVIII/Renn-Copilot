import { useMemo, useState } from "react";
import { api, type CredentialUsageEntry } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { MaskedEmail } from "./Modal";
import { useEmailReveal } from "../hooks/useEmailReveal";
import { ratesFor, formatUsd, formatCompactNumber, formatResetIn, rateLimitColor } from "../lib/utils";

const PROVIDER_LABELS: Record<string, string> = {
  antigravity: "Antigravity",
  claude: "Claude",
  codex: "Codex",
};

type SortKey = "priority" | "requests" | "totalTokens" | "label";
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "priority", label: "Priority" },
  { key: "requests", label: "Requests" },
  { key: "totalTokens", label: "Total tokens" },
  { key: "label", label: "Name" },
];
const PAGE_SIZE_OPTIONS = [10, 25, 50];

function labelFor(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

// A window's cost is estimated from its own token count at a single blended
// per-token rate (input/output split isn't tracked per-window) -- rough, but
// consistent with the "approximate" framing already used for the token-usage
// table elsewhere on this page.
function estimateWindowCostUsd(tokens: number, provider: string): number {
  const rates = ratesFor(provider);
  return (tokens / 1_000_000) * ((rates.input + rates.output) / 2);
}

/**
 * Per-credential usage + live quota table for the Usage page, inspired by
 * cpa-usage-keeper's dashboard (github.com/Willxup/cpa-usage-keeper) but
 * adapted to this backend's existing data sources instead of requiring a
 * separate Redis-backed service: request/token/cache-rate totals come from
 * CLIProxyAPI's usage-queue (see usage-store.js's getUsageByCredential).
 * Only Codex gets a live 5h/weekly quota bar (see backend's codex-usage.js) --
 * Antigravity's equivalent was removed since its only real quota data is
 * Gemini-only with no matching 5h/weekly split, and getting its Claude/GPT
 * usage would require spoofing a client identity to Google.
 */
export function AuthFilesTable() {
  const { data, mutate, isLoading } = usePolling(api.getUsageCredentials, 20000);
  const [activeTab, setActiveTab] = useState("all");
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);
  const { revealed } = useEmailReveal();

  const credentials = data?.credentials ?? [];

  const presentProviders = Array.from(new Set(credentials.map((c) => c.provider)));
  const tabs = ["all", ...presentProviders];

  const filtered = useMemo(() => {
    let rows = activeTab === "all" ? credentials : credentials.filter((c) => c.provider === activeTab);
    if (enabledOnly) rows = rows.filter((c) => !c.disabled);
    const sorted = [...rows].sort((a, b) => {
      switch (sortKey) {
        case "requests":
          return b.requests - a.requests;
        case "totalTokens":
          return b.totalTokens - a.totalTokens;
        case "label":
          return a.label.localeCompare(b.label);
        default:
          // "Priority": unavailable/disabled credentials surfaced last, otherwise stable insertion order.
          return Number(a.disabled || a.unavailable) - Number(b.disabled || b.unavailable);
      }
    });
    return sorted;
  }, [credentials, activeTab, enabledOnly, sortKey]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);

  function changeTab(tab: string) {
    setActiveTab(tab);
    setPage(0);
  }

  return (
    <div className="card">
      <div className="tabs" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {tabs.map((tab) => {
            const count = tab === "all" ? credentials.length : credentials.filter((c) => c.provider === tab).length;
            return (
              <button key={tab} className={`btn secondary ${activeTab === tab ? "active" : ""}`} onClick={() => changeTab(tab)}>
                {tab === "all" ? "All" : labelFor(tab)} ({count})
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <span className="badge neutral">{credentials.length} credentials</span>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" className="toggle" checked={enabledOnly} onChange={(e) => setEnabledOnly(e.target.checked)} />
            Enabled only
          </label>
        </div>
        <button className="btn secondary" onClick={() => mutate(undefined, true)}>
          ↻ Update quotas
        </button>
      </div>

      <div className="card-desc" style={{ marginTop: 6 }}>
        View request activity and quota status for local auth files.
      </div>

      {isLoading && <p className="page-hint">Loading...</p>}
      {!isLoading && filtered.length === 0 && <p className="page-hint">No credentials match this filter.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        {pageRows.map((c) => (
          <CredentialRow key={c.name} entry={c} revealed={revealed} />
        ))}
      </div>

      {filtered.length > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="card-desc">Size</span>
            <select
              className="text-input"
              style={{ width: 70 }}
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="card-desc">Sort</span>
            <select className="text-input" style={{ width: 130 }} value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              {SORT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="btn-row">
            <button className="btn secondary" disabled={clampedPage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              Previous
            </button>
            <span className="card-desc">
              {clampedPage + 1}/{pageCount}
            </span>
            <button className="btn secondary" disabled={clampedPage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CredentialRow({ entry, revealed }: { entry: CredentialUsageEntry; revealed: boolean }) {
  const total = entry.requests;
  const successPct = total > 0 ? Math.round(((total - entry.failedRequests) / total) * 100) : null;
  const critical = entry.disabled || entry.unavailable;

  return (
    <div className="cred-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span className={`health-dot ${critical ? "bad" : "ok"}`} />
          <span>
            <MaskedEmail email={entry.label} revealed={revealed} />
          </span>
          <span className="cred-row-sub">{labelFor(entry.provider)}</span>
          {entry.disabled && <span className="badge neutral">Disabled</span>}
          {entry.unavailable && <span className="badge neutral">Unavailable</span>}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <StatChip label="Total Requests" value={String(total)} sub={successPct !== null ? `(${total - entry.failedRequests}/${entry.failedRequests})` : undefined} />
          <StatChip label="Success Rate" value={successPct !== null ? `${successPct}%` : "-"} />
          <StatChip label="Total Tokens" value={formatCompactNumber(entry.totalTokens)} />
          <StatChip label="Cache Rate" value={`${entry.cacheRate}%`} />
        </div>
      </div>

      {entry.quota ? <QuotaBars entry={entry} /> : <p className="card-desc">No live quota data for this credential.</p>}
    </div>
  );
}

function StatChip({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div className="card-desc" style={{ fontSize: "0.75em" }}>
        {label}
      </div>
      <div>
        {value} {sub && <span className="card-desc">{sub}</span>}
      </div>
    </div>
  );
}

function QuotaBars({ entry }: { entry: CredentialUsageEntry }) {
  const q = entry.quota!;
  if (!q.ok) {
    return <p className="card-desc">Quota: unavailable ({q.reason ?? "unknown"})</p>;
  }
  if (!q.primary && !q.secondary) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {q.primary && <WindowBar label="5h" usedPercent={q.primary.usedPercent} resetAfterSeconds={q.primary.resetAfterSeconds} tokens={entry.window5hTokens} provider={entry.provider} />}
      {q.secondary && (
        <WindowBar label="Weekly" usedPercent={q.secondary.usedPercent} resetAfterSeconds={q.secondary.resetAfterSeconds} tokens={entry.window7dTokens} provider={entry.provider} />
      )}
    </div>
  );
}

function WindowBar({
  label,
  usedPercent,
  resetAfterSeconds,
  tokens,
  provider,
}: {
  label: string;
  usedPercent: number | null;
  resetAfterSeconds: number | null;
  tokens: number;
  provider: string;
}) {
  const resetIn = resetAfterSeconds ? formatResetIn(Date.now() + resetAfterSeconds * 1000) : null;
  const cost = estimateWindowCostUsd(tokens, provider);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className="card-desc" style={{ minWidth: 46 }}>
        {label}
      </span>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${usedPercent ?? 0}%`, background: rateLimitColor(usedPercent) }} />
      </div>
      <span className="card-desc" style={{ minWidth: 60, textAlign: "right" }}>
        {usedPercent ?? "?"}%{resetIn ? ` · ${resetIn}` : ""}
      </span>
      <span className="card-desc" style={{ minWidth: 130, textAlign: "right" }}>
        {formatCompactNumber(tokens)} tok · {formatUsd(cost)}
      </span>
    </div>
  );
}
