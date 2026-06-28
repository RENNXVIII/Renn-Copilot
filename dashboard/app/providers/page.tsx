"use client";
import useSWR from "swr";
import { useEffect, useState } from "react";
import { api, type ApiKeyEntry, type AuthFileEntry, type OpenAiCompatEntry } from "@/lib/api";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Dialog, DialogHeader } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { MaskedEmail } from "@/components/ui/masked-email";
import { useEmailReveal } from "@/lib/use-email-reveal";
import { loadCustomGroups, saveCustomGroups } from "@/lib/custom-groups";
import { Eye, EyeOff, Blocks, KeyRound } from "lucide-react";
import Link from "next/link";
import { IconBadge, type IconBadgeTone, type IconComponent } from "@/components/ui/icon-badge";
import { AntigravityIcon, ClaudeIcon, CodexIcon } from "@/components/ui/provider-icons";

// Each provider's real brand mark, kept in one shared module
// (provider-icons.tsx) so this page and the Models page stay visually
// consistent.
const PROVIDER_VISUALS: Record<"antigravity" | "claude" | "codex", { icon: IconComponent; tone: IconBadgeTone }> = {
  antigravity: { icon: AntigravityIcon, tone: "sky" },
  claude: { icon: ClaudeIcon, tone: "amber" },
  codex: { icon: CodexIcon, tone: "teal" },
};

// Each card below maps an OAuth login provider to the API-key slot CLIProxyAPI
// considers the closest substitute -- Antigravity is Google OAuth, and its
// nearest non-OAuth equivalent is a raw Gemini API key, since that's the
// model family Antigravity itself exposes.
const PROVIDER_CARDS: {
  id: "antigravity" | "claude" | "codex";
  label: string;
  description: string;
  apiKey: { key: "gemini" | "claude" | "codex"; label: string; getter: () => Promise<{ items: ApiKeyEntry[] }>; setter: (items: ApiKeyEntry[]) => Promise<{ items: ApiKeyEntry[] }> };
  oauthDisabled?: boolean;
  oauthDisabledReason?: string;
}[] = [
  {
    id: "antigravity",
    label: "Antigravity (Google)",
    description: "Login via Google to access Antigravity's Claude + Gemini models.",
    apiKey: { key: "gemini", label: "Gemini API Key", getter: api.getGeminiKeys, setter: api.setGeminiKeys },
  },
  {
    id: "claude",
    label: "Claude / Claude Code",
    description: "Login with your Claude.ai / Claude Code account (Anthropic OAuth).",
    apiKey: { key: "claude", label: "Claude API Key", getter: api.getClaudeKeys, setter: api.setClaudeKeys },
    // Anthropic now bills third-party-app usage of consumer (Pro/Max/Free)
    // OAuth tokens against a separate "extra usage" credit pool instead of
    // the plan's included quota -- so logging in here no longer gets you
    // what this card implies. Disabled until there's a real fix (e.g. a
    // documented way to use these tokens without tripping that billing
    // path); use "Add via API key" with a console.anthropic.com key instead,
    // which is billed transparently and isn't affected.
    oauthDisabled: true,
    oauthDisabledReason:
      "Anthropic now bills third-party OAuth usage as \"extra usage\" instead of plan quota -- disabled here until that's resolved. Use \"Add via API key\" instead.",
  },
  {
    id: "codex",
    label: "Codex (ChatGPT)",
    description: "Login with your ChatGPT account to use ChatGPT Codex models.",
    apiKey: { key: "codex", label: "Codex API Key", getter: api.getCodexKeys, setter: api.setCodexKeys },
  },
];

type LoginState = "idle" | "waiting" | "ok" | "error";

const BAN_STORAGE_KEY = "renn-copilot:provider-bans";

// CLIProxyAPI's own auth-url endpoints rate-limit per IP and respond with a
// message like "... 403 IP banned due to too many failed attempts. Try again
// in 29m33s". We parse that out so the button can self-disable instead of
// inviting another click that just resets the same cooldown upstream.
function parseBanDeadline(message: string): number | null {
  const match = message.match(/try again in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
  if (totalMs <= 0) return null;
  return Date.now() + totalMs;
}

function loadBans(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(BAN_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveBans(bans: Record<string, number>) {
  window.localStorage.setItem(BAN_STORAGE_KEY, JSON.stringify(bans));
}

// next_retry_after's exact format isn't pinned down by CLIProxyAPI's docs --
// handle both a unix-seconds/ms number and an ISO date string defensively.
function formatNextRetry(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const num = typeof value === "number" ? value : Number(value);
  const ms = Number.isFinite(num) ? (num > 1e12 ? num : num * 1000) : Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(8)}${key.slice(-4)}`;
}

export default function ProvidersPage() {
  const { data: status } = useSWR("status", api.getStatus, { refreshInterval: 4000 });
  const serverRunning = status?.running ?? false;
  // Don't poll auth-files (which hits CLIProxyAPI's Management API) until the
  // server is actually up -- otherwise this just spams ECONNREFUSED every 8s.
  const { data, mutate } = useSWR(serverRunning ? "auth-files" : null, api.getAuthFiles, {
    refreshInterval: 8000,
  });
  const [loginStates, setLoginStates] = useState<Record<string, LoginState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [bannedUntil, setBannedUntil] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const [apiKeyModal, setApiKeyModal] = useState<(typeof PROVIDER_CARDS)[number]["apiKey"] | null>(null);
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string>("antigravity");
  const [customGroups, setCustomGroups] = useState<Record<string, string>>({});
  const { toast } = useToast();
  const { revealed, toggle: toggleRevealed } = useEmailReveal();

  // Restore any cooldown that's still active across reloads (a ban can outlast
  // a single dashboard session since it lasts up to ~30 minutes).
  useEffect(() => {
    setBannedUntil(loadBans());
  }, []);

  useEffect(() => {
    setCustomGroups(loadCustomGroups());
  }, []);

  function assignCustomGroup(name: string, group: string) {
    setCustomGroups((g) => {
      const next = { ...g, [name]: group };
      saveCustomGroups(next);
      return next;
    });
  }

  // Fetched at page level (not just inside their modals) so the grouped
  // "Stored credentials" view can show them without the modal being open.
  const geminiKeysQuery = useSWR(
    serverRunning ? `api-key-${PROVIDER_CARDS[0].apiKey.label}` : null,
    PROVIDER_CARDS[0].apiKey.getter
  );
  const claudeKeysQuery = useSWR(
    serverRunning ? `api-key-${PROVIDER_CARDS[1].apiKey.label}` : null,
    PROVIDER_CARDS[1].apiKey.getter
  );
  const codexKeysQuery = useSWR(
    serverRunning ? `api-key-${PROVIDER_CARDS[2].apiKey.label}` : null,
    PROVIDER_CARDS[2].apiKey.getter
  );
  const apiKeyQueriesById: Record<string, typeof geminiKeysQuery> = {
    antigravity: geminiKeysQuery,
    claude: claudeKeysQuery,
    codex: codexKeysQuery,
  };
  const customQuery = useSWR(serverRunning ? "openai-compat" : null, api.getOpenAiCompat);
  const customItems = customQuery.data?.items ?? [];
  const customGroupNames = Array.from(
    new Set(customItems.map((it) => customGroups[it.name] || "Ungrouped"))
  ).filter((g) => !["antigravity", "claude", "codex"].includes(g));
  const allGroups: { id: string; label: string }[] = [
    ...PROVIDER_CARDS.map((p) => ({ id: p.id, label: p.label })),
    ...customGroupNames.map((g) => ({ id: g, label: g })),
  ];
  const groupOptions = Array.from(new Set(["antigravity", "claude", "codex", ...customGroupNames]));

  function countForGroup(id: string): number {
    if (id === "antigravity" || id === "claude" || id === "codex") {
      const oauthCount = data?.files?.filter((f) => f.provider === id).length ?? 0;
      const keyCount = apiKeyQueriesById[id]?.data?.items?.length ?? 0;
      return oauthCount + keyCount;
    }
    return customItems.filter((it) => (customGroups[it.name] || "Ungrouped") === id).length;
  }

  function renderGroupRows() {
    const isFixed = selectedGroup === "antigravity" || selectedGroup === "claude" || selectedGroup === "codex";
    if (isFixed) {
      const oauthAccounts = data?.files?.filter((f) => f.provider === selectedGroup) ?? [];
      const keyQuery = apiKeyQueriesById[selectedGroup];
      const keyItems = keyQuery?.data?.items ?? [];
      const keyConfig = PROVIDER_CARDS.find((p) => p.id === selectedGroup)!.apiKey;
      const empty = !oauthAccounts.length && !keyItems.length;
      return (
        <>
          {empty && <p className="text-sm text-muted-foreground">No credentials in this group yet.</p>}
          {oauthAccounts.length > 1 && (
            <div className="flex items-center justify-end gap-2 pb-1">
              <Button
                size="sm"
                variant="outline"
                disabled={oauthAccounts.every((f) => !f.disabled)}
                onClick={() => bulkSetOAuthDisabled(oauthAccounts, false)}
              >
                Enable all
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={oauthAccounts.every((f) => !!f.disabled)}
                onClick={() => bulkSetOAuthDisabled(oauthAccounts, true)}
              >
                Disable all
              </Button>
            </div>
          )}
          {oauthAccounts.map((f) => (
            <div key={f.name} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
              <div>
                <p className="font-medium">
                  {f.email ? <MaskedEmail email={f.email} /> : f.name}
                </p>
                <p className="text-xs text-muted-foreground">OAuth · {f.provider}</p>
              </div>
              <div className="flex items-center gap-3">
                {f.unavailable && (
                  <Badge variant="secondary" className="text-amber-600">
                    Quota exceeded{formatNextRetry(f.next_retry_after) ? ` · retry ~${formatNextRetry(f.next_retry_after)}` : ""}
                  </Badge>
                )}
                <Badge variant={f.status === "ready" ? "success" : "secondary"}>{f.status}</Badge>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{f.disabled ? "Inactive" : "Active"}</span>
                  <Switch checked={!f.disabled} onCheckedChange={(v) => toggleActive(f, v)} />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!f.auth_index || resetting[f.name]}
                  title={!f.auth_index ? "No auth_index reported for this credential" : undefined}
                  onClick={() => handleResetQuota(f)}
                >
                  {resetting[f.name] ? "Resetting..." : "Reset Quota"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => api.deleteAuthFile(f.name).then(() => mutate())}>
                  Remove
                </Button>
              </div>
            </div>
          ))}
          {keyItems.map((entry, i) => (
            <div key={`key-${i}`} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
              <div>
                <p className="font-mono">{maskKey(entry["api-key"])}</p>
                <p className="text-xs text-muted-foreground">
                  {keyConfig.label}
                  {entry["base-url"] ? ` · ${entry["base-url"]}` : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await keyConfig.setter(keyItems.filter((_, idx) => idx !== i));
                  keyQuery?.mutate();
                }}
              >
                Remove
              </Button>
            </div>
          ))}
        </>
      );
    }

    const groupItems = customItems
      .map((entry, idx) => ({ entry, idx }))
      .filter(({ entry }) => (customGroups[entry.name] || "Ungrouped") === selectedGroup);
    return (
      <>
        {!groupItems.length && <p className="text-sm text-muted-foreground">No credentials in this group yet.</p>}
        {groupItems.length > 1 && (
          <div className="flex items-center justify-end gap-2 pb-1">
            <Button
              size="sm"
              variant="outline"
              disabled={groupItems.every(({ entry }) => !entry.disabled)}
              onClick={() => bulkSetCustomDisabled(groupItems, false)}
            >
              Enable all
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={groupItems.every(({ entry }) => !!entry.disabled)}
              onClick={() => bulkSetCustomDisabled(groupItems, true)}
            >
              Disable all
            </Button>
          </div>
        )}
        {groupItems.map(({ entry, idx }) => (
          <div key={entry.name} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
            <div>
              <div className="flex items-center gap-2 font-medium">
                {entry.name} {entry.disabled && <Badge variant="secondary">disabled</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">{entry["base-url"]}</p>
              {entry["api-key-entries"]?.[0] && (
                <p className="font-mono text-xs text-muted-foreground">
                  {maskKey(entry["api-key-entries"][0]["api-key"])}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await api.setOpenAiCompat(
                    customItems.map((it, i) => (i === idx ? { ...it, disabled: !it.disabled } : it))
                  );
                  customQuery.mutate();
                }}
              >
                {entry.disabled ? "Enable" : "Disable"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await api.setOpenAiCompat(customItems.filter((_, i) => i !== idx));
                  customQuery.mutate();
                }}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
      </>
    );
  }

  // Tick once a second only while at least one provider is actually banned,
  // so the countdown updates without polling the backend.
  useEffect(() => {
    const anyBanned = Object.values(bannedUntil).some((t) => t > now);
    if (!anyBanned) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [bannedUntil, now]);

  // Active = !disabled. Disabling a credential via the Management API takes it
  // out of CLIProxyAPI's routing/round-robin entirely (no requests will use it)
  // without deleting the stored token, so it can be flipped back on later.
  async function toggleActive(f: AuthFileEntry, active: boolean) {
    const disabled = !active;
    mutate(
      data ? { files: data.files.map((x) => (x.name === f.name ? { ...x, disabled } : x)) } : data,
      false
    );
    try {
      await api.setAuthFileDisabled(f.name, disabled);
      toast({ title: active ? `${f.label || f.name} enabled` : `${f.label || f.name} disabled`, variant: "success" });
    } catch (err) {
      toast({
        title: "Failed to update credential",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      mutate();
    }
  }

  // Bulk variant of toggleActive -- used by the per-group "Enable all /
  // Disable all" buttons in the Stored credentials panel. Fires the API calls
  // in parallel (these are independent rows) and refreshes once at the end
  // rather than once per row.
  async function bulkSetOAuthDisabled(accounts: AuthFileEntry[], disabled: boolean) {
    const targets = accounts.filter((f) => !!f.disabled !== disabled);
    if (!targets.length) return;
    try {
      await Promise.all(targets.map((f) => api.setAuthFileDisabled(f.name, disabled)));
      toast({ title: `${targets.length} credential${targets.length === 1 ? "" : "s"} ${disabled ? "disabled" : "enabled"}`, variant: "success" });
    } catch (err) {
      toast({
        title: "Bulk update failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      mutate();
    }
  }

  // Custom (openai-compat) entries are stored as one array on the backend, so
  // a bulk toggle is a single PUT with every targeted index flipped, instead
  // of N separate round-trips.
  async function bulkSetCustomDisabled(items: { entry: OpenAiCompatEntry; idx: number }[], disabled: boolean) {
    const targets = items.filter(({ entry }) => !!entry.disabled !== disabled);
    if (!targets.length) return;
    const idxSet = new Set(targets.map((t) => t.idx));
    try {
      await api.setOpenAiCompat(customItems.map((it, i) => (idxSet.has(i) ? { ...it, disabled } : it)));
      toast({ title: `${targets.length} credential${targets.length === 1 ? "" : "s"} ${disabled ? "disabled" : "enabled"}`, variant: "success" });
    } catch (err) {
      toast({
        title: "Bulk update failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      customQuery.mutate();
    }
  }

  const [resetting, setResetting] = useState<Record<string, boolean>>({});

  async function handleResetQuota(f: AuthFileEntry) {
    if (!f.auth_index) return;
    setResetting((s) => ({ ...s, [f.name]: true }));
    try {
      await api.resetQuota(f.auth_index);
      toast({ title: `Quota reset for ${f.label || f.name}`, variant: "success" });
    } catch (err) {
      toast({
        title: "Failed to reset quota",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      setResetting((s) => ({ ...s, [f.name]: false }));
      mutate();
    }
  }

  function setBan(provider: string, deadline: number) {
    setBannedUntil((b) => {
      const next = { ...b, [provider]: deadline };
      saveBans(next);
      return next;
    });
  }

  async function startLogin(provider: "antigravity" | "claude" | "codex") {
    if (!serverRunning) return;
    setLoginStates((s) => ({ ...s, [provider]: "waiting" }));
    try {
      const { url, state } = await api.startLogin(provider);
      window.open(url, "_blank", "noopener,noreferrer");
      pollLogin(provider, state);
    } catch (err: any) {
      setLoginStates((s) => ({ ...s, [provider]: "error" }));
      setErrors((e) => ({ ...e, [provider]: err.message }));
      toast({ title: `${provider} login failed`, description: err.message, variant: "error" });
      const deadline = parseBanDeadline(err.message || "");
      if (deadline) setBan(provider, deadline);
    }
  }

  function pollLogin(provider: string, state: string) {
    const interval = setInterval(async () => {
      try {
        const res = await api.pollLoginStatus(state);
        if (res.status === "ok") {
          clearInterval(interval);
          setLoginStates((s) => ({ ...s, [provider]: "ok" }));
          toast({ title: `${provider} login successful`, variant: "success" });
          mutate();
        } else if (res.status === "error") {
          clearInterval(interval);
          setLoginStates((s) => ({ ...s, [provider]: "error" }));
          setErrors((e) => ({ ...e, [provider]: res.error || "Authentication failed" }));
          toast({ title: `${provider} login failed`, description: res.error || "Authentication failed", variant: "error" });
        }
      } catch {
        // keep polling; transient network errors are expected while CLIProxyAPI restarts
      }
    }, 2000);
    setTimeout(() => clearInterval(interval), 5 * 60 * 1000);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Providers & Login</h1>
        <p className="text-sm text-muted-foreground">
          Connect each provider via OAuth, or add a raw API key instead. Tokens and keys are stored by CLIProxyAPI
          under its auth directory.
        </p>
      </div>

      {!serverRunning && (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          CLIProxyAPI isn&apos;t running yet, so login can&apos;t reach its Management API.{" "}
          <Link href="/" className="font-medium text-foreground underline">
            Go to Overview and click Start
          </Link>{" "}
          first.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {PROVIDER_CARDS.map((p) => {
          const state = loginStates[p.id] ?? "idle";
          const banDeadline = bannedUntil[p.id];
          const isBanned = !!banDeadline && banDeadline > now;
          return (
            <Card key={p.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <IconBadge icon={PROVIDER_VISUALS[p.id].icon} tone={PROVIDER_VISUALS[p.id].tone} shape="circle" />
                    <CardTitle>{p.label}</CardTitle>
                  </div>
                  {p.oauthDisabled && <Badge variant="secondary">Maintenance</Badge>}
                </div>
                <CardDescription>{p.description}</CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                {p.oauthDisabled && (
                  <p className="text-xs text-muted-foreground">{p.oauthDisabledReason}</p>
                )}
                {isBanned ? (
                  <p className="text-xs text-destructive">
                    Rate-limited by the provider — retry in {formatRemaining(banDeadline - now)}
                  </p>
                ) : (
                  state === "error" && <p className="text-xs text-destructive">{errors[p.id]}</p>
                )}
                {state === "ok" && <Badge variant="success">Logged in</Badge>}
                {state === "waiting" && <Badge variant="secondary">Waiting for browser...</Badge>}
              </CardContent>
              <CardFooter className="flex flex-col gap-2">
                <Button
                  className="w-full"
                  onClick={() => startLogin(p.id)}
                  disabled={state === "waiting" || isBanned || !serverRunning || p.oauthDisabled}
                  title={
                    p.oauthDisabled
                      ? p.oauthDisabledReason
                      : !serverRunning
                      ? "Start CLIProxyAPI first (Overview page)"
                      : undefined
                  }
                >
                  {p.oauthDisabled
                    ? "Under maintenance"
                    : isBanned
                    ? `Retry in ${formatRemaining(banDeadline - now)}`
                    : state === "waiting"
                    ? "Waiting..."
                    : !serverRunning
                    ? "Server not running"
                    : "Login via OAuth"}
                </Button>
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={() => setApiKeyModal(p.apiKey)}
                  disabled={!serverRunning}
                  title={!serverRunning ? "Start CLIProxyAPI first (Overview page)" : undefined}
                >
                  Add via API key
                </Button>
              </CardFooter>
            </Card>
          );
        })}

        <Card className="flex flex-col">
          <CardHeader>
            <div className="flex items-center gap-2.5">
              <IconBadge icon={Blocks} tone="slate" shape="circle" />
              <CardTitle>Custom provider</CardTitle>
            </div>
            <CardDescription>
              OpenAI-compatible endpoint -- GLM, Kimi/Moonshot, or anything else that speaks the OpenAI
              chat-completions API.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1" />
          <CardFooter>
            <Button
              className="w-full"
              variant="outline"
              onClick={() => setCustomModalOpen(true)}
              disabled={!serverRunning}
              title={!serverRunning ? "Start CLIProxyAPI first (Overview page)" : undefined}
            >
              Add custom provider
            </Button>
          </CardFooter>
        </Card>
      </div>

      <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
        Gemini CLI, Qwen, and iFlow don&apos;t expose an OAuth URL through CLIProxyAPI&apos;s
        Management API yet — authenticate those via the CLIProxyAPI CLI directly
        (see the README&apos;s &quot;Known limitations&quot; section), then they&apos;ll show up below.
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
                Stored credentials
              </CardTitle>
              <CardDescription>Accounts and keys CLIProxyAPI currently has, grouped by provider.</CardDescription>
            </div>
            {/* Single global switch for every email shown below (and in the VS
                Code extension's status bar) -- replaces what used to be a
                separate reveal/hide icon on each row. */}
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-2"
              onClick={() => toggleRevealed()}
            >
              {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {revealed ? "Hide emails" : "Reveal emails"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex gap-0 p-0">
          <div className="flex w-64 shrink-0 flex-col gap-1 border-r border-border p-2">
            {allGroups.map((g) => (
              <button
                key={g.id}
                onClick={() => setSelectedGroup(g.id)}
                title={g.label}
                className={cn(
                  "flex items-start justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                  selectedGroup === g.id
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <span className="break-words leading-snug">{g.label}</span>
                <span className="shrink-0 text-xs">{countForGroup(g.id)}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-1 flex-col gap-2 p-4">{renderGroupRows()}</div>
        </CardContent>
      </Card>

      <Dialog open={apiKeyModal !== null} onClose={() => setApiKeyModal(null)}>
        {apiKeyModal && (
          <ApiKeyModalContent
            label={apiKeyModal.label}
            getter={apiKeyModal.getter}
            setter={apiKeyModal.setter}
            onClose={() => setApiKeyModal(null)}
          />
        )}
      </Dialog>

      <Dialog open={customModalOpen} onClose={() => setCustomModalOpen(false)}>
        <CustomProviderModalContent
          onClose={() => setCustomModalOpen(false)}
          groupOptions={groupOptions}
          onAssignGroup={assignCustomGroup}
        />
      </Dialog>
    </div>
  );
}

// --- API key modal (Gemini / Claude / Codex raw keys) -----------------------

function ApiKeyModalContent({
  label,
  getter,
  setter,
  onClose,
}: {
  label: string;
  getter: () => Promise<{ items: ApiKeyEntry[] }>;
  setter: (items: ApiKeyEntry[]) => Promise<{ items: ApiKeyEntry[] }>;
  onClose: () => void;
}) {
  const { data, mutate, isLoading } = useSWR(`api-key-${label}`, getter);
  const items = data?.items ?? [];
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);

  async function addEntry() {
    if (!apiKey.trim()) return;
    const entry: ApiKeyEntry = { "api-key": apiKey.trim() };
    if (baseUrl.trim()) entry["base-url"] = baseUrl.trim();
    setSaving(true);
    try {
      await setter([...items, entry]);
      setApiKey("");
      setBaseUrl("");
    } finally {
      setSaving(false);
      mutate();
    }
  }

  async function removeEntry(index: number) {
    setSaving(true);
    try {
      await setter(items.filter((_, i) => i !== index));
    } finally {
      setSaving(false);
      mutate();
    }
  }

  return (
    <>
      <DialogHeader title={label} description={`${items.length} key${items.length === 1 ? "" : "s"} configured`} onClose={onClose} />
      <div className="flex flex-col gap-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {!isLoading && !items.length && <p className="text-sm text-muted-foreground">No keys yet.</p>}
        {items.map((entry, i) => (
          <div key={i} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
            <div>
              <p className="font-mono">{maskKey(entry["api-key"])}</p>
              {entry["base-url"] && <p className="text-xs text-muted-foreground">{entry["base-url"]}</p>}
            </div>
            <Button size="sm" variant="outline" disabled={saving} onClick={() => removeEntry(i)}>
              Remove
            </Button>
          </div>
        ))}

        <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3">
          <div>
            <label className="text-xs text-muted-foreground">API key</label>
            <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Base URL (optional)</label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="leave blank for default" />
          </div>
          <Button size="sm" className="self-start" disabled={saving || !apiKey.trim()} onClick={addEntry}>
            Add
          </Button>
        </div>
      </div>
    </>
  );
}

// --- Custom provider modal (OpenAI-compatible endpoints) --------------------

function CustomProviderModalContent({
  onClose,
  groupOptions,
  onAssignGroup,
}: {
  onClose: () => void;
  groupOptions: string[];
  onAssignGroup: (name: string, group: string) => void;
}) {
  const { data, mutate, isLoading } = useSWR("openai-compat", api.getOpenAiCompat);
  const items = data?.items ?? [];
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [group, setGroup] = useState("");
  const [modelIds, setModelIds] = useState("");
  const [saving, setSaving] = useState(false);

  async function addEntry() {
    if (!name.trim() || !baseUrl.trim() || !apiKey.trim() || !group.trim()) return;
    // CLIProxyAPI only exposes a model id via GET /v1/models (and therefore on
    // the Models page) if it's listed in this entry's `models` array -- without
    // it, the proxy has no declared list of what this endpoint serves.
    const models = modelIds
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .map((m) => ({ name: m }));
    const entry: OpenAiCompatEntry = {
      name: name.trim(),
      "base-url": baseUrl.trim(),
      "api-key-entries": [{ "api-key": apiKey.trim() }],
      ...(models.length ? { models } : {}),
    };
    setSaving(true);
    try {
      await api.setOpenAiCompat([...items, entry]);
      // Group is dashboard-only metadata -- saved locally, never sent to CLIProxyAPI.
      onAssignGroup(entry.name, group.trim());
      setName("");
      setBaseUrl("");
      setApiKey("");
      setGroup("");
      setModelIds("");
    } finally {
      setSaving(false);
      mutate();
    }
  }

  async function removeEntry(index: number) {
    setSaving(true);
    try {
      await api.setOpenAiCompat(items.filter((_, i) => i !== index));
    } finally {
      setSaving(false);
      mutate();
    }
  }

  async function toggleDisabled(index: number, disabled: boolean) {
    setSaving(true);
    try {
      await api.setOpenAiCompat(items.map((it, i) => (i === index ? { ...it, disabled } : it)));
    } finally {
      setSaving(false);
      mutate();
    }
  }

  return (
    <>
      <DialogHeader
        title="Custom provider"
        description="GLM, Kimi/Moonshot, or any other endpoint that speaks the OpenAI chat-completions API."
        onClose={onClose}
      />
      <div className="flex flex-col gap-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {!isLoading && !items.length && <p className="text-sm text-muted-foreground">No custom providers yet.</p>}
        {items.map((entry, i) => (
          <div key={i} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
            <div>
              <div className="flex items-center gap-2 font-medium">
                {entry.name} {entry.disabled && <Badge variant="secondary">disabled</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">{entry["base-url"]}</p>
              {entry["api-key-entries"]?.[0] && (
                <p className="font-mono text-xs text-muted-foreground">
                  {maskKey(entry["api-key-entries"][0]["api-key"])}
                </p>
              )}
              {entry.models?.length ? (
                <p className="text-xs text-muted-foreground">
                  Models: {entry.models.map((m) => m.alias || m.name).join(", ")}
                </p>
              ) : (
                <p className="text-xs text-amber-600">
                  No model IDs registered yet -- won&apos;t show up on the Models page.
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={saving} onClick={() => toggleDisabled(i, !entry.disabled)}>
                {entry.disabled ? "Enable" : "Disable"}
              </Button>
              <Button size="sm" variant="outline" disabled={saving} onClick={() => removeEntry(i)}>
                Remove
              </Button>
            </div>
          </div>
        ))}

        <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3">
          <div>
            <label className="text-xs text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="glm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Base URL</label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">API key</label>
            <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Group</label>
            <Input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="antigravity / claude / codex / or a new group"
              list="custom-provider-groups"
            />
            <datalist id="custom-provider-groups">
              {groupOptions.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Model IDs (comma-separated)</label>
            <Input
              value={modelIds}
              onChange={(e) => setModelIds(e.target.value)}
              placeholder="minimax-m3, glm-4-plus"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Without this, CLIProxyAPI doesn&apos;t know which models this endpoint serves -- they won&apos;t show
              up on the Models page.
            </p>
          </div>
          <Button
            size="sm"
            className="self-start"
            disabled={saving || !name.trim() || !baseUrl.trim() || !apiKey.trim() || !group.trim()}
            onClick={addEntry}
          >
            Add provider
          </Button>
        </div>
      </div>
    </>
  );
}
