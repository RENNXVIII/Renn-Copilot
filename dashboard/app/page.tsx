"use client";

import useSWR from "swr";
import Link from "next/link";
import { api, type UsageAccount, type UsageApiKey, type DayUsage } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { shortenPath } from "@/lib/utils";
import { MaskedEmail } from "@/components/ui/masked-email";
import { useToast } from "@/components/ui/toast";
import { useState } from "react";
import { IconBadge, type IconBadgeTone } from "@/components/ui/icon-badge";
import { KeyRound, Cpu, Activity, Puzzle, Server, ListChecks, HeartPulse, Coins, type LucideIcon } from "lucide-react";

const ACTION_LABELS: Record<string, string> = {
  install: "Binary installed",
  start: "Server started",
  stop: "Server stopped",
  restart: "Server restarted",
};

const TOKEN_USAGE_DAYS = 7;

export default function OverviewPage() {
  const { data: status, mutate, isLoading } = useSWR("status", api.getStatus, { refreshInterval: 4000 });
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();

  const serverRunning = status?.running ?? false;
  const { data: models } = useSWR(serverRunning ? "models" : null, api.getModels, { refreshInterval: 15000 });
  const { data: usage } = useSWR(serverRunning ? "usage" : null, api.getUsage, { refreshInterval: 10000 });
  const { data: tokenData } = useSWR(
    serverRunning ? "usage-tokens" : null,
    () => api.getUsageTokens(TOKEN_USAGE_DAYS),
    { refreshInterval: 20000 }
  );
  const { data: extStatus } = useSWR("extension-status", api.getExtensionStatus, { refreshInterval: 8000 });

  async function run(action: string, fn: () => Promise<unknown>) {
    setBusy(action);
    try {
      await fn();
      toast({ title: ACTION_LABELS[action] ?? action, variant: "success" });
    } catch (err) {
      toast({
        title: `Failed: ${action}`,
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      setBusy(null);
      mutate();
    }
  }

  const credentials = [...(usage?.accounts ?? []), ...(usage?.apiKeys ?? [])];
  const unavailableCount = (usage?.accounts ?? []).filter((a) => a.disabled || a.unavailable).length;
  const availableCount = credentials.length - unavailableCount;

  const enabledModels = models?.models.filter((m) => m.enabled).length ?? 0;
  const totalModels = models?.models.length ?? 0;

  const totalRequests = (usage?.totals.success ?? 0) + (usage?.totals.failed ?? 0);
  const successRate = totalRequests > 0 ? Math.round(((usage?.totals.success ?? 0) / totalRequests) * 100) : null;

  const extensionReady = !!extStatus?.lastVsix;

  const checklist = [
    { label: "Binary installed", done: !!status?.binaryInstalled },
    { label: "Server running", done: serverRunning },
    { label: "At least 1 account/API key connected", done: credentials.length > 0 },
    { label: "At least 1 model enabled", done: enabledModels > 0 },
    { label: "VS Code extension built & installed", done: extensionReady },
  ];
  const checklistDone = checklist.filter((c) => c.done).length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Server, accounts, models, and the VS Code extension at a glance.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Accounts & API keys"
          value={credentials.length ? `${availableCount}/${credentials.length}` : "-"}
          hint={credentials.length ? "available / total" : "Nothing connected yet"}
          tone={unavailableCount > 0 ? "warning" : "default"}
          href="/providers"
          icon={KeyRound}
          iconTone="sky"
        />
        <KpiCard
          label="Active models"
          value={totalModels ? `${enabledModels}/${totalModels}` : "-"}
          hint={totalModels ? "enabled / total" : "Server isn't running"}
          href="/models"
          icon={Cpu}
          iconTone="violet"
        />
        <KpiCard
          label="Requests (last ~3.3h)"
          value={totalRequests ? String(totalRequests) : "-"}
          hint={successRate !== null ? `${successRate}% success` : "No data yet"}
          tone={successRate !== null && successRate < 90 ? "warning" : "default"}
          href="/usage"
          icon={Activity}
          iconTone="indigo"
        />
        <KpiCard
          label="VS Code extension"
          value={extensionReady ? "Ready" : "Not yet"}
          hint={extStatus?.lastTask ? `Last: ${extStatus.lastTask}` : "Never built"}
          tone={extensionReady ? "default" : "warning"}
          href="/extension"
          icon={Puzzle}
          iconTone="teal"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                CLIProxyAPI server
              </CardTitle>
              {status && (
                <Badge variant={status.running ? "success" : "secondary"}>
                  {status.running ? "Running" : "Stopped"}
                </Badge>
              )}
            </div>
            <CardDescription>
              {isLoading ? "Checking status..." : status?.home ? shortenPath(status.home) : "-"}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm">
            <Info label="Binary installed" value={status?.binaryInstalled ? "Yes" : "No"} />
            <Info label="Last error" value={status?.lastStartError ?? "None"} />
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy !== null} onClick={() => run("install", api.install)}>
              {busy === "install" ? "Installing..." : "Install / Update binary"}
            </Button>
            <Button disabled={busy !== null || status?.running} onClick={() => run("start", api.start)}>
              {busy === "start" ? "Starting..." : "Start"}
            </Button>
            <Button variant="outline" disabled={busy !== null || !status?.running} onClick={() => run("stop", api.stop)}>
              {busy === "stop" ? "Stopping..." : "Stop"}
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => run("restart", api.restart)}>
              {busy === "restart" ? "Restarting..." : "Restart"}
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-muted-foreground" />
              Setup checklist
            </CardTitle>
            <CardDescription>{checklistDone}/{checklist.length} done</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {checklist.map((c) => (
              <div key={c.label} className="flex items-center gap-2 text-sm">
                <span
                  className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                    c.done ? "bg-emerald-500 text-white" : "border border-border text-transparent"
                  }`}
                >
                  ✓
                </span>
                <span className={c.done ? "text-foreground" : "text-muted-foreground"}>{c.label}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HeartPulse className="h-4 w-4 text-muted-foreground" />
              Health monitor
            </CardTitle>
            <CardDescription>Account & API key status at a glance. Full detail on the Usage page.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col">
            {!serverRunning && (
              <p className="text-sm text-muted-foreground">Server isn&apos;t running, so there&apos;s no account health data.</p>
            )}
            {serverRunning && credentials.length === 0 && (
              <p className="text-sm text-muted-foreground">No accounts or API keys connected yet.</p>
            )}
            {serverRunning && credentials.length > 0 && (
              <div className="flex flex-col gap-2">
                {(usage?.accounts ?? []).slice(0, 4).map((a) => <MiniHealthRow key={a.name} usage={a} />)}
                {(usage?.apiKeys ?? []).slice(0, Math.max(0, 4 - (usage?.accounts?.length ?? 0))).map((k, i) => (
                  <MiniHealthRow key={`${k.provider}-${i}`} usage={k} />
                ))}
              </div>
            )}
            {serverRunning && credentials.length > 4 && (
              <Link href="/usage" className="mt-auto inline-block pt-3 text-xs font-medium text-foreground underline">
                View all ({credentials.length})
              </Link>
            )}
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-muted-foreground" />
              Token usage ({TOKEN_USAGE_DAYS}d)
            </CardTitle>
            <CardDescription>Total tokens per day, as reported directly by each provider.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col">
            {!serverRunning && <p className="text-sm text-muted-foreground">Server isn&apos;t running.</p>}
            {serverRunning && (!tokenData || tokenData.byDay.length === 0) && (
              <p className="text-sm text-muted-foreground">No token usage data yet.</p>
            )}
            {/* A single day's bar would render as one solid block at 100% height --
                technically correct but reads like a broken/half-loaded chart. Wait
                for at least 2 days before drawing it, same threshold as the Usage
                page's full version. */}
            {serverRunning && tokenData && tokenData.byDay.length === 1 && (
              <p className="text-sm text-muted-foreground">
                Only 1 day recorded so far -- check back tomorrow for a trend.
              </p>
            )}
            {serverRunning && tokenData && tokenData.byDay.length > 1 && <MiniTrendChart byDay={tokenData.byDay} />}
            {serverRunning && tokenData && (
              <Link href="/usage" className="mt-auto inline-block pt-3 text-xs font-medium text-foreground underline">
                View detail by provider & model
              </Link>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate font-medium">{value}</p>
    </div>
  );
}

function KpiCard({
  label,
  value,
  hint,
  tone = "default",
  href,
  icon,
  iconTone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "warning";
  href: string;
  icon: LucideIcon;
  iconTone: IconBadgeTone;
}) {
  return (
    <Link href={href}>
      <Card className="transition-colors hover:border-foreground/30">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardDescription>{label}</CardDescription>
              <CardTitle className={`text-2xl ${tone === "warning" ? "text-amber-600" : ""}`}>{value}</CardTitle>
            </div>
            {/* Warning state borrows the amber tone too, so the icon and the
                value agree on "something here needs attention" at a glance. */}
            <IconBadge icon={icon} tone={tone === "warning" ? "amber" : iconTone} />
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">{hint}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

/** Compact one-line version of the Usage page's HealthCard, for the Overview summary. */
function MiniHealthRow({ usage }: { usage: UsageAccount | UsageApiKey }) {
  const isAccount = "label" in usage;
  const critical = isAccount && (usage.disabled || usage.unavailable);
  const reason = !isAccount
    ? "Available"
    : usage.disabled
      ? "Inactive"
      : usage.unavailable
        ? "Quota exceeded"
        : "Available";

  return (
    <div className="flex items-center gap-3 rounded-md border border-border p-2.5">
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${critical ? "bg-red-500" : "bg-emerald-500"}`} />
      <p className="min-w-0 flex-1 truncate text-sm font-medium">
        {isAccount ? <MaskedEmail email={usage.label} /> : usage.name || usage.keyMasked}
      </p>
      <span className={`shrink-0 text-xs ${critical ? "text-amber-600" : "text-muted-foreground"}`}>{reason}</span>
    </div>
  );
}

/** Smaller variant of the Usage page's DailyTrendChart, sized for a 2-column card. */
function MiniTrendChart({ byDay }: { byDay: DayUsage[] }) {
  const max = Math.max(1, ...byDay.map((d) => d.total_tokens));
  return (
    <div className="flex h-16 items-end gap-1.5">
      {byDay.map((d) => {
        const pct = Math.max(2, (d.total_tokens / max) * 100);
        return (
          <div
            key={d.day}
            className="flex flex-1 flex-col items-center gap-1"
            title={`${d.day}: ${d.total_tokens.toLocaleString("en-US")} tokens, ${d.requests} requests`}
          >
            <div className="flex h-12 w-full items-end">
              <div className="w-full rounded-t-sm bg-emerald-500/70" style={{ height: `${pct}%` }} />
            </div>
            <span className="text-[10px] text-muted-foreground">{d.day.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}
