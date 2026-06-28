const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:4317";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const message = (data && (data as any).error) || text || res.statusText;
    throw new Error(message);
  }
  return data as T;
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface ServerStatus {
  running: boolean;
  pid: number | null;
  binaryInstalled: boolean;
  configExists: boolean;
  lastStartError: string | null;
  home: string;
  managementUrl: string;
}

export interface ModelEntry {
  id: string;
  provider: string;
  family: string;
  label: string;
  thinking: boolean;
  enabled: boolean;
}

export interface ExtensionStatus {
  busy: boolean;
  lastTask: "compile" | "package" | "install" | null;
  lastExitCode: number | null;
  lastError: string | null;
  lastVsix: string | null;
  extensionDir: string;
  dirExists: boolean;
}

export interface AuthFileEntry {
  id: string;
  name: string;
  provider: string;
  status: string;
  status_message?: string;
  disabled?: boolean;
  email?: string;
  // Display label used by the dashboard (falls back to email/name when unset).
  label?: string;
  // Set by CLIProxyAPI itself (not user-toggled) when a quota/rate-limit hit
  // makes the account temporarily unusable; next_retry_after is a unix-ish
  // timestamp string/number depending on CLIProxyAPI version.
  unavailable?: boolean;
  next_retry_after?: string | number | null;
  // Stable runtime id required by POST /reset-quota -- distinct from `name`.
  auth_index?: string;
}

export interface UsageBucket {
  time: string; // "HH:MM-HH:MM", local time, 10 minutes per bucket
  success: number;
  failed: number;
}

export interface UsageAccount {
  name: string;
  label: string;
  provider: string;
  disabled: boolean;
  unavailable: boolean;
  success: number;
  failed: number;
  recent_requests: UsageBucket[];
  // Format varies by CLIProxyAPI version (unix timestamp or ISO string) --
  // parse defensively, see parseRetryAfter() in app/usage/page.tsx.
  next_retry_after: string | number | null;
}

export interface UsageApiKey {
  provider: string;
  // Friendly name from a matching openai-compatibility entry's `name` field
  // (matched server-side by base URL), e.g. "minimax-m3" -- null when there's
  // no match (plain Gemini/Claude/Codex extra API keys have no name to show).
  name: string | null;
  baseUrl: string | null;
  keyMasked: string;
  success: number;
  failed: number;
  recent_requests: UsageBucket[];
}

export interface UsageResponse {
  accounts: UsageAccount[];
  apiKeys: UsageApiKey[];
  totals: { success: number; failed: number };
}

// Token-level usage as reported directly by the provider in each response
// body (not estimated by CLIProxyAPI), drained from its pop-and-remove
// /usage-queue endpoint and aggregated by our own backend -- see
// backend/src/usage-store.js for how these numbers accumulate over time.
export interface UsageTokenTotals {
  requests: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
}

export interface ProviderModelUsage extends UsageTokenTotals {
  provider: string;
  model: string;
}

export interface DayUsage {
  day: string; // "YYYY-MM-DD"
  total_tokens: number;
  requests: number;
}

export interface RecentUsageRecord {
  timestamp: string | null;
  provider: string;
  model: string;
  failed: boolean;
  latency_ms: number | null;
  tokens: Partial<Omit<UsageTokenTotals, "requests" | "failed">>;
  endpoint: string | null;
  auth_type: string | null;
}

export interface UsageTokenSummary {
  totals: UsageTokenTotals;
  byProviderModel: ProviderModelUsage[];
  byDay: DayUsage[];
  recent: RecentUsageRecord[];
  availableDays: number;
}

export interface ApiKeyEntry {
  "api-key": string;
  "base-url"?: string;
  "proxy-url"?: string;
  models?: { name: string; alias?: string }[];
  [key: string]: unknown;
}

export interface RoutingStrategy {
  strategy: "round-robin" | "fill-first";
}

export interface OpenAiCompatEntry {
  name: string;
  "base-url": string;
  priority?: number;
  disabled?: boolean;
  prefix?: string;
  "api-key-entries"?: { "api-key": string; "proxy-url"?: string }[];
  models?: { name: string; alias?: string; "force-mapping"?: boolean }[];
  [key: string]: unknown;
}

export const api = {
  getStatus: () => request<ServerStatus>("/server/status"),
  install: () => request<{ ok: boolean; version: string }>("/server/install", { method: "POST" }),
  start: () => request<ServerStatus>("/server/start", { method: "POST" }),
  stop: () => request<ServerStatus>("/server/stop", { method: "POST" }),
  restart: () => request<ServerStatus>("/server/restart", { method: "POST" }),
  getOwnLogs: () => request<{ lines: string[] }>("/server/logs"),
  getProxyLogs: (after?: number) =>
    request<{ lines: string[]; "line-count": number; "latest-timestamp": number }>(
      `/proxy-logs${after ? `?after=${after}` : ""}`
    ),

  getModels: () =>
    request<{ models: ModelEntry[]; source: "live" | "empty"; liveError: string | null }>("/models"),
  setEnabledModels: (enabledModelIds: string[]) =>
    request<{ ok: boolean; enabledModelIds: string[] }>("/models", {
      method: "PUT",
      body: JSON.stringify({ enabledModelIds }),
    }),

  getAuthFiles: () => request<{ files: AuthFileEntry[] }>("/auth-files"),
  getUsage: () => request<UsageResponse>("/usage"),
  getUsageTokens: (days = 7) => request<UsageTokenSummary>(`/usage/tokens?days=${days}`),
  deleteAuthFile: (name: string) =>
    request<{ status: string }>(`/auth-files/${encodeURIComponent(name)}`, { method: "DELETE" }),
  setAuthFileDisabled: (name: string, disabled: boolean) =>
    request<{ status: string; disabled: boolean }>("/auth-files/status", {
      method: "PATCH",
      body: JSON.stringify({ name, disabled }),
    }),
  resetQuota: (authIndex: string) =>
    request<{ status: string; auth_index: string }>("/auth-files/reset-quota", {
      method: "POST",
      body: JSON.stringify({ authIndex }),
    }),

  // --- Custom API-key providers (GLM, Kimi, or any OpenAI-compatible endpoint,
  // plus extra Gemini/Claude/Codex API keys alongside OAuth logins) ----------
  getOpenAiCompat: () => request<{ items: OpenAiCompatEntry[] }>("/api-providers/openai-compat"),
  setOpenAiCompat: (items: OpenAiCompatEntry[]) =>
    request<{ items: OpenAiCompatEntry[] }>("/api-providers/openai-compat", {
      method: "PUT",
      body: JSON.stringify({ items }),
    }),
  getGeminiKeys: () => request<{ items: ApiKeyEntry[] }>("/api-providers/gemini-key"),
  setGeminiKeys: (items: ApiKeyEntry[]) =>
    request<{ items: ApiKeyEntry[] }>("/api-providers/gemini-key", {
      method: "PUT",
      body: JSON.stringify({ items }),
    }),
  getClaudeKeys: () => request<{ items: ApiKeyEntry[] }>("/api-providers/claude-key"),
  setClaudeKeys: (items: ApiKeyEntry[]) =>
    request<{ items: ApiKeyEntry[] }>("/api-providers/claude-key", {
      method: "PUT",
      body: JSON.stringify({ items }),
    }),
  getCodexKeys: () => request<{ items: ApiKeyEntry[] }>("/api-providers/codex-key"),
  setCodexKeys: (items: ApiKeyEntry[]) =>
    request<{ items: ApiKeyEntry[] }>("/api-providers/codex-key", {
      method: "PUT",
      body: JSON.stringify({ items }),
    }),

  startLogin: (provider: "antigravity" | "claude" | "codex") =>
    request<{ status: string; url: string; state: string }>(`/providers/${provider}/login`),
  pollLoginStatus: (state: string) =>
    request<{ status: "wait" | "ok" | "error"; error?: string }>(
      `/providers/login-status?state=${encodeURIComponent(state)}`
    ),

  getExtensionStatus: () => request<ExtensionStatus>("/extension/status"),
  getExtensionLogs: () => request<{ lines: string[] }>("/extension/logs"),
  compileExtension: () => request<ExtensionStatus>("/extension/compile", { method: "POST" }),
  packageExtension: () => request<ExtensionStatus>("/extension/package", { method: "POST" }),
  installExtension: () =>
    request<ExtensionStatus>("/extension/install", { method: "POST", body: JSON.stringify({}) }),

  getRoutingStrategy: () => request<RoutingStrategy>("/routing-strategy"),
  setRoutingStrategy: (strategy: RoutingStrategy["strategy"]) =>
    request<RoutingStrategy>("/routing-strategy", {
      method: "PUT",
      body: JSON.stringify({ strategy }),
    }),

  getPreferences: () => request<{ revealEmails: boolean }>("/preferences"),
  setPreferences: (revealEmails: boolean) =>
    request<{ revealEmails: boolean }>("/preferences", {
      method: "PUT",
      body: JSON.stringify({ revealEmails }),
    }),

  getConfigYaml: () => request<string>("/config.yaml"),
  putConfigYaml: (yamlText: string) =>
    fetch(`${BACKEND_URL}/api/config.yaml`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: yamlText,
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to save config");
      return data;
    }),
};
