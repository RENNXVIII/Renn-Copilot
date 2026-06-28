"use client";

import useSWR from "swr";
import { useMemo, useState } from "react";
import {
  api,
  type UsageAccount,
  type UsageApiKey,
  type UsageBucket,
  type ProviderModelUsage,
  type RecentUsageRecord,
} from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MaskedEmail } from "@/components/ui/masked-email";
import Link from "next/link";
import { IconBadge } from "@/components/ui/icon-badge";
import { Activity, CheckCircle2, XCircle, Coins, HeartPulse, KeyRound, Lock, Search, ArrowUp, ArrowDown } from "lucide-react";

type SortKey = "provider" | "model" | "requests" | "input_tokens" | "output_tokens" | "total_tokens";

const SORTABLE_COLUMNS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "provider", label: "Provider" },
  { key: "model", label: "Model" },
  { key: "requests", label: "Requests", align: "right" },
  { key: "input_tokens", label: "Input tokens", align: "right" },
  { key: "output_tokens", label: "Output tokens", align: "right" },
  { key: "total_tokens", label: "Total tokens", align: "right" },
];

// CLIProxyAPI's recent_requests is a fixed-length list of 20 buckets (10 min
// each, ~3.3h total) -- not a full day. Label things accordingly so the page
// doesn't imply more history than the upstream API actually keeps.
const BUCKET_WINDOW_LABEL = "last ~3.3h";
const TOKEN_USAGE_DAYS = 7;

// Rough, static USD-per-1M-token rates for a *rough* "what would this have
// cost on a paid API key" estimate. These are not pulled from any billing
// API -- CLIProxyAPI doesn't expose real cost data -- so treat this purely
// as an informational ballpark, not an actual bill. Matched by substring
// against the provider name from byProviderModel; falls back to a generic
// blended rate for anything unrecognized (custom OpenAI-compatible providers).
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

/**
 * CLIProxyAPI's next_retry_after format varies by version (seen as either a
 * unix timestamp -- seconds or ms -- or an ISO string). Parsed defensively;
 * if we can't make sense of it, we just don't show a countdown rather than
 * risk showing a wrong one.
 */
function parseRetryAfter(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const asNum = typeof value === "number" ? value : Number(value);
  if (!Number.isNaN(asNum) && asNum > 0) {
    return asNum > 1e12 ? asNum : asNum * 1000; // ms vs. seconds heuristic
  }
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

export default function UsagePage() {
  const { data: status } = useSWR("status", api.getStatus, { refreshInterval: 4000 });
  const serverRunning = status?.running ?? false;
  const { data, error } = useSWR(serverRunning ? "usage" : null, api.getUsage, {
    refreshInterval: 10000,
  });
  const { data: tokenData, error: tokenError } = useSWR(
    serverRunning ? "usage-tokens" : null,
    () => api.getUsageTokens(TOKEN_USAGE_DAYS),
    { refreshInterval: 20000 }
  );

  const [tableQuery, setTableQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("total_tokens");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const visibleRows = useMemo(() => {
    const rows = tokenData?.byProviderModel ?? [];
    const q = tableQuery.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => r.provider.toLowerCase().includes(q) || r.model.toLowerCase().includes(q))
      : rows;
    const sorted = [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [tokenData?.byProviderModel, tableQuery, sortKey, sortDir]);

  const totalRequests = (data?.totals.success ?? 0) + (data?.totals.failed ?? 0);
  const successRate = totalRequests > 0 ? Math.round(((data?.totals.success ?? 0) / totalRequests) * 100) : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Usage</h1>
        <p className="text-sm text-muted-foreground">
          Request counts per account and API key, as tracked by CLIProxyAPI since it last started.
        </p>
      </div>

      {serverRunning && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-muted-foreground" />
              Token usage by provider &amp; model
            </CardTitle>
            <CardDescription>
              Token counts as reported directly by each provider in its own response (last {TOKEN_USAGE_DAYS} days
              we&apos;ve recorded{tokenData ? `, out of ${tokenData.availableDays} day(s) stored` : ""}). Unlike the
              counters below, this comes straight from the upstream API&apos;s usage field, not an estimate.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {tokenError && (
              <p className="text-sm text-destructive">Couldn&apos;t load token usage: {tokenError.message}</p>
            )}
            {!tokenError && tokenData && tokenData.byProviderModel.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No token usage recorded yet. This fills in a few minutes after requests start flowing (we poll
                CLIProxyAPI&apos;s usage queue every 15s).
              </p>
            )}
            {!tokenError && tokenData && tokenData.byProviderModel.length > 0 && (
              <>
                <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 sm:max-w-xs">
                  <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input
                    value={tableQuery}
                    onChange={(e) => setTableQuery(e.target.value)}
                    placeholder="Filter by provider or model..."
                    className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        {SORTABLE_COLUMNS.map((col) => (
                          <th key={col.key} className={`py-2 pr-4 font-medium ${col.align === "right" ? "text-right" : ""}`}>
                            <button
                              type="button"
                              onClick={() => toggleSort(col.key)}
                              className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${col.align === "right" ? "flex-row-reverse" : ""}`}
                            >
                              {col.label}
                              {sortKey === col.key &&
                                (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.length === 0 && (
                        <tr>
                          <td colSpan={SORTABLE_COLUMNS.length} className="py-4 text-center text-muted-foreground">
                            No rows match your filter.
                          </td>
                        </tr>
                      )}
                      {visibleRows.map((row: ProviderModelUsage) => (
                        <tr key={`${row.provider}::${row.model}`} className="border-b border-border/50 last:border-0">
                          <td className="py-2 pr-4">{row.provider}</td>
                          <td className="py-2 pr-4 text-muted-foreground">{row.model}</td>
                          <td className="py-2 pr-4 text-right">{formatNumber(row.requests)}</td>
                          <td className="py-2 pr-4 text-right">{formatNumber(row.input_tokens)}</td>
                          <td className="py-2 pr-4 text-right">{formatNumber(row.output_tokens)}</td>
                          <td className="py-2 pr-0 text-right font-medium">{formatNumber(row.total_tokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {!tokenError && tokenData && tokenData.byProviderModel.length > 0 && (
              <div className="flex items-baseline justify-between rounded-md border border-dashed border-border p-3">
                <div>
                  <p className="text-sm font-medium">
                    Estimated cost on a paid API key: {formatUsd(estimateCostUsd(tokenData.byProviderModel))}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Rough estimate from static public per-token rates × tokens used over the last {TOKEN_USAGE_DAYS}{" "}
                    days. CLIProxyAPI doesn&apos;t report real billing -- this is informational only, not an actual
                    invoice. Routing through OAuth logins instead of metered keys is what makes this $0 in practice.
                  </p>
                </div>
              </div>
            )}

            {!tokenError && tokenData && tokenData.byDay.length > 1 && (
              <DailyTrendChart byDay={tokenData.byDay} />
            )}

            {!tokenError && tokenData && tokenData.recent.length > 0 && (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Recent requests ({tokenData.recent.length})
                </summary>
                <div className="mt-2 flex flex-col gap-1">
                  {tokenData.recent.slice(0, 20).map((r: RecentUsageRecord, i: number) => (
                    <div key={i} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-muted-foreground">
                        {r.timestamp ? new Date(r.timestamp).toLocaleString() : "unknown time"}
                      </span>
                      <span className="truncate">
                        {r.provider} / {r.model}
                      </span>
                      <span className={r.failed ? "text-destructive" : "text-muted-foreground"}>
                        {r.failed ? "failed" : `${formatNumber(r.tokens.total_tokens ?? 0)} tok`}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </CardContent>
        </Card>
      )}

      {!serverRunning && (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          CLIProxyAPI isn&apos;t running, so there&apos;s no usage data to show.{" "}
          <Link href="/" className="font-medium text-foreground underline">
            Go to Overview and click Start
          </Link>{" "}
          first.
        </div>
      )}

      {serverRunning && error && (
        <div className="rounded-md border border-dashed border-destructive/50 p-4 text-sm text-destructive">
          Couldn&apos;t load usage: {error.message}
        </div>
      )}

      {serverRunning && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardDescription>Total requests ({BUCKET_WINDOW_LABEL})</CardDescription>
                  <CardTitle className="text-3xl">{totalRequests}</CardTitle>
                </div>
                <IconBadge icon={Activity} tone="indigo" />
              </div>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardDescription>Successful</CardDescription>
                  <CardTitle className="text-3xl text-emerald-600">{data?.totals.success ?? 0}</CardTitle>
                </div>
                <IconBadge icon={CheckCircle2} tone="emerald" />
              </div>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardDescription>Failed</CardDescription>
                  <CardTitle className="text-3xl text-destructive">{data?.totals.failed ?? 0}</CardTitle>
                </div>
                <IconBadge icon={XCircle} tone="rose" />
              </div>
            </CardHeader>
          </Card>
        </div>
      )}

      {serverRunning && successRate !== null && (
        <p className="text-xs text-muted-foreground">Success rate: {successRate}% across all accounts and keys.</p>
      )}

      {serverRunning && (data?.accounts?.length || data?.apiKeys?.length) ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HeartPulse className="h-4 w-4 text-muted-foreground" />
              Health monitor
            </CardTitle>
            <CardDescription>Live auth status across every account &amp; key. Refreshes every 10s.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {data?.accounts?.map((a) => <HealthCard key={a.name} usage={a} />)}
              {data?.apiKeys?.map((k, i) => <HealthCard key={`${k.provider}-${k.keyMasked}-${i}`} usage={k} />)}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            OAuth accounts
          </CardTitle>
          <CardDescription>Per-account request counts. Manage logins on the Providers page.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {serverRunning && !data?.accounts?.length && (
            <p className="text-sm text-muted-foreground">No accounts logged in yet.</p>
          )}
          {data?.accounts?.map((a) => <UsageRow key={a.name} usage={a} />)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted-foreground" />
            API keys
          </CardTitle>
          <CardDescription>
            Non-OAuth providers (OpenAI-compatible, plus extra Gemini/Claude/Codex keys). Manage on the Providers page.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {serverRunning && !data?.apiKeys?.length && (
            <p className="text-sm text-muted-foreground">No API keys configured yet.</p>
          )}
          {data?.apiKeys?.map((k, i) => <UsageRow key={`${k.provider}-${k.keyMasked}-${i}`} usage={k} />)}
        </CardContent>
      </Card>
    </div>
  );
}

// Mirrors CLIProxyAPI's own binary "unavailable" concept -- no numeric quota
// is exposed, so this is just that flag (account-level), not a heuristic.
type Health = "ok" | "critical";

function getHealth(usage: UsageAccount | UsageApiKey): { level: Health; reason: string } {
  const isAccount = "label" in usage;
  if (isAccount && usage.disabled) return { level: "critical", reason: "Account is inactive" };
  if (isAccount && usage.unavailable) return { level: "critical", reason: "CLIProxyAPI reports quota exceeded" };
  return { level: "ok", reason: "Available" };
}

const HEALTH_DOT_CLASS: Record<Health, string> = {
  ok: "bg-emerald-500",
  critical: "bg-red-500",
};

function HealthDot({ usage }: { usage: UsageAccount | UsageApiKey }) {
  const { level, reason } = getHealth(usage);
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${HEALTH_DOT_CLASS[level]}`} title={reason} />;
}

const HEALTH_PULSE_CLASS: Record<Health, string> = {
  ok: "bg-emerald-500",
  critical: "bg-red-500 animate-pulse",
};

/** Compact monitor card: live dot + name + one-line status, refreshed alongside the rest of the page's SWR poll. */
function HealthCard({ usage }: { usage: UsageAccount | UsageApiKey }) {
  const isAccount = "label" in usage;
  const { level, reason } = getHealth(usage);
  const resetIn = isAccount ? formatResetIn(parseRetryAfter(usage.next_retry_after)) : null;

  return (
    <div className="flex items-center gap-3 rounded-md border border-border p-3">
      <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${HEALTH_PULSE_CLASS[level]}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {isAccount ? <MaskedEmail email={usage.label} /> : usage.name || usage.keyMasked}
        </p>
        <p className={`truncate text-xs ${level === "critical" ? "text-amber-600" : "text-muted-foreground"}`}>
          {reason}
          {resetIn && level === "critical" ? ` · resets ${resetIn}` : ""}
        </p>
      </div>
    </div>
  );
}

function UsageRow({ usage }: { usage: UsageAccount | UsageApiKey }) {
  const isAccount = "label" in usage;
  const subtitle = isAccount
    ? usage.provider
    : `${usage.provider}${usage.baseUrl ? ` · ${usage.baseUrl}` : ""}`;
  const resetIn = isAccount ? formatResetIn(parseRetryAfter(usage.next_retry_after)) : null;
  const total = usage.success + usage.failed;
  const successPct = total > 0 ? Math.round((usage.success / total) * 100) : null;
  // API keys have no quota/unavailable concept upstream -- only OAuth accounts do.
  const unavailable = isAccount && usage.unavailable;

  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <HealthDot usage={usage} />
          <p className="truncate font-medium">
            {isAccount ? <MaskedEmail email={usage.label} /> : usage.keyMasked}
          </p>
          {isAccount && usage.disabled && <Badge variant="secondary">Inactive</Badge>}
          {isAccount && usage.unavailable && (
            <Badge variant="secondary" className="text-amber-600">
              Quota exceeded{resetIn ? ` · resets ${resetIn}` : ""}
            </Badge>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        {/* CLIProxyAPI doesn't expose a numeric quota -- this bar shows the
            success/failed mix of requests so far as a proxy for "how healthy
            is this credential right now", not a real remaining-quota meter. */}
        {total > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={unavailable ? "h-full bg-amber-500" : "h-full bg-emerald-500"}
                style={{ width: `${successPct}%` }}
              />
            </div>
            <span className="w-9 shrink-0 text-right text-[11px] text-muted-foreground">{successPct}%</span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-4">
        <div className="text-right">
          <p className="font-medium">
            <span className="text-emerald-600">{usage.success}</span>
            {" / "}
            <span className={usage.failed > 0 ? "text-destructive" : "text-muted-foreground"}>{usage.failed}</span>
          </p>
          <p className="text-xs text-muted-foreground">ok / failed</p>
        </div>
        <Sparkline buckets={usage.recent_requests} />
      </div>
    </div>
  );
}

/** Tiny stacked bar chart from the 20 most-recent 10-minute buckets. No chart library needed for this. */
function Sparkline({ buckets }: { buckets: UsageBucket[] }) {
  if (!buckets?.length) {
    return <p className="w-[120px] text-center text-xs text-muted-foreground">No recent activity</p>;
  }
  const max = Math.max(1, ...buckets.map((b) => b.success + b.failed));
  return (
    <div className="flex h-8 w-[120px] items-end gap-[2px]" title={`Request volume, ${BUCKET_WINDOW_LABEL}`}>
      {buckets.map((b, i) => {
        const total = b.success + b.failed;
        const barPct = total > 0 ? Math.max(8, (total / max) * 100) : 0;
        const successPct = total > 0 ? barPct * (b.success / total) : 0;
        const failedPct = total > 0 ? barPct * (b.failed / total) : 0;
        return (
          <div
            key={i}
            className="flex h-full w-[4px] flex-col-reverse"
            title={`${b.time}: ${b.success} ok, ${b.failed} failed`}
          >
            <div className="w-full rounded-[1px] bg-emerald-500" style={{ height: `${successPct}%` }} />
            <div className="w-full rounded-[1px] bg-destructive" style={{ height: `${failedPct}%` }} />
          </div>
        );
      })}
    </div>
  );
}

/** Plain-div bar chart of total tokens per day. No chart library -- consistent with Sparkline above. */
function DailyTrendChart({ byDay }: { byDay: { day: string; total_tokens: number; requests: number }[] }) {
  const max = Math.max(1, ...byDay.map((d) => d.total_tokens));
  return (
    <div className="mt-1">
      <p className="mb-2 text-xs text-muted-foreground">Daily total tokens</p>
      <div className="flex h-20 items-end gap-2">
        {byDay.map((d) => {
          const pct = Math.max(2, (d.total_tokens / max) * 100);
          return (
            <div key={d.day} className="flex flex-1 flex-col items-center gap-1" title={`${d.day}: ${d.total_tokens.toLocaleString("en-US")} tokens, ${d.requests} requests`}>
              <div className="flex h-16 w-full items-end">
                <div className="w-full rounded-t-sm bg-emerald-500/70" style={{ height: `${pct}%` }} />
              </div>
              <span className="text-[10px] text-muted-foreground">{d.day.slice(5)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
