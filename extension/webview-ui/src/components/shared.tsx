import type { DayUsage, UsageAccount, UsageApiKey } from "../api/client";

export function KpiCard({
  label,
  value,
  hint,
  warning,
  onClick,
}: {
  label: string;
  value: string;
  hint: string;
  warning?: boolean;
  onClick?: () => void;
}) {
  return (
    <div className="card" onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
      <div className="card-desc">{label}</div>
      <div className={`kpi-value ${warning ? "warning" : ""}`}>{value}</div>
      <div className="card-desc">{hint}</div>
    </div>
  );
}

/** Compact one-line health row -- shared by Overview's summary and Models' provider list. */
export function HealthRow({ usage }: { usage: UsageAccount | UsageApiKey }) {
  const isAccount = "label" in usage;
  const critical = isAccount && (usage.disabled || usage.unavailable);
  const reason = !isAccount ? "Available" : usage.disabled ? "Inactive" : usage.unavailable ? "Quota exceeded" : "Available";
  const label = isAccount ? usage.label : usage.name || usage.keyMasked;

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
