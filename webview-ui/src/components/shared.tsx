import type React from "react";
import type { DayUsage, UsageAccount, UsageApiKey } from "../api/client";
import { maskEmail } from "../lib/utils";
import { colorFor, rgba } from "../pages/neuron/palette";

export function KpiCard({
  label,
  value,
  hint,
  warning,
  onClick,
  footer,
}: {
  label: string;
  value: string;
  hint: string;
  warning?: boolean;
  onClick?: () => void;
  footer?: React.ReactNode;
}) {
  return (
    <div className="card" onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
      <div className="card-desc">{label}</div>
      <div className={`kpi-value ${warning ? "warning" : ""}`}>{value}</div>
      <div className="card-desc">{hint}</div>
      {footer}
    </div>
  );
}

/** Compact one-line health row -- shared by Overview's summary and Models' provider list. */
export function HealthRow({ usage, revealed = false }: { usage: UsageAccount | UsageApiKey; revealed?: boolean }) {
  const isAccount = "label" in usage;
  const critical = isAccount && (usage.disabled || usage.unavailable);
  const reason = !isAccount ? "Available" : usage.disabled ? "Inactive" : usage.unavailable ? "Quota exceeded" : "Available";
  const rawLabel = isAccount ? usage.label : usage.name || usage.keyMasked;
  const label = isAccount && !revealed ? maskEmail(rawLabel) : rawLabel;

  return (
    <div className="health-row">
      <span className={`health-dot ${critical ? "bad" : "ok"}`} />
      <span className="health-label">{label}</span>
      <span className="card-desc">{reason}</span>
    </div>
  );
}

export function TrendChart({ byDay }: { byDay: DayUsage[] }) {
  const max = Math.max(1, ...byDay.map((d) => d.total_tokens));
  return (
    <div className="trend-chart">
      {byDay.map((d) => {
        const pct = Math.max(2, (d.total_tokens / max) * 100);
        return (
          <div key={d.day} className="trend-bar-col" title={`${d.day}: ${d.total_tokens.toLocaleString()} tokens, ${d.requests} requests`}>
            <div className="trend-bar-track">
              <div className="trend-bar" style={{ height: `${pct}%` }} />
            </div>
            <span className="trend-day">{d.day.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Two-segment success/failed meter. Counts are real; nothing is invented. */
export function SuccessMeter({ success, failed }: { success: number; failed: number }) {
  const total = success + failed;
  if (total === 0) return null;
  const failPct = (failed / total) * 100;
  return (
    <div className="meter" title={`${success} success, ${failed} failed`}>
      <div className="meter-fill ok" style={{ width: `${100 - failPct}%` }} />
      <div className="meter-fill bad" style={{ width: `${failPct}%` }} />
    </div>
  );
}

/** Stacked request-share bar across providers, driven by real per-account counts. */
export function ProviderMix({ rows }: { rows: { provider: string; requests: number }[] }) {
  const byProvider = new Map<string, number>();
  for (const r of rows) byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + r.requests);
  const entries = [...byProvider.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total === 0) return null;

  return (
    <div className="provider-mix">
      <div className="mix-bar">
        {entries.map(([provider, n]) => (
          <div
            key={provider}
            className="mix-seg"
            style={{ width: `${(n / total) * 100}%`, background: rgba(colorFor(provider), 0.85) }}
            title={`${provider}: ${n} requests`}
          />
        ))}
      </div>
      <div className="mix-legend">
        {entries.map(([provider, n]) => (
          <span key={provider} className="mix-legend-item">
            <span className="mix-dot" style={{ background: rgba(colorFor(provider), 0.9) }} />
            {provider}
            <span className="card-desc">{Math.round((n / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Checklist({ items }: { items: { label: string; done: boolean }[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((c) => (
        <div key={c.label} className="checklist-item">
          <span className={`checklist-dot ${c.done ? "done" : ""}`}>{c.done ? "✓" : ""}</span>
          <span style={{ opacity: c.done ? 1 : 0.7 }}>{c.label}</span>
        </div>
      ))}
    </div>
  );
}
