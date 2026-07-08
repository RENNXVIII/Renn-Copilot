// Ported from dashboard/lib/api.ts. Only change: the backend base URL comes
// from a runtime global injected by extension/src/webview-html.ts (reads the
// user's rennCopilot.backendUrl setting at render time) instead of a
// Next.js build-time env var, so it stays correct without rebuilding.
declare global {
  interface Window {
    __RENN_BACKEND_URL__?: string;
  }
}

const BACKEND_URL = window.__RENN_BACKEND_URL__ || "http://127.0.0.1:4317";

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

export interface ModelCapabilities {
  vision: boolean | "unknown";
  note?: string;
  checkedAt?: number;
}

export interface ModelEntry {
  id: string;
  provider: string;
  family: string;
  label: string;
  thinking: boolean;
  enabled: boolean;
  capabilities: ModelCapabilities;
}

export interface AuthFileEntry {
  id: string;
  name: string;
  provider: string;
  status: string;
  status_message?: string;
  disabled?: boolean;
  email?: string;
  label?: string;
  unavailable?: boolean;
  next_retry_after?: string | number | null;
  auth_index?: string;
}

export interface UsageBucket {
  time: string;
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
  next_retry_after: string | number | null;
}

export interface UsageApiKey {
  provider: string;
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

export interface CodexRateWindow {
  usedPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
}

export interface CodexUsageEntry {
  name: string;
  label: string;
  ok: boolean;
  reason?: string;
  planType?: string | null;
  primary?: CodexRateWindow | null;
  secondary?: CodexRateWindow | null;
}

export interface AntigravityQuotaBucket {
  modelId: string | null;
  usedPercent: number | null;
  resetAfterSeconds: number | null;
}

export interface AntigravityUsageEntry {
  name: string;
  label: string;
  ok: boolean;
  reason?: string;
  verifyUrl?: string;
  worst?: AntigravityQuotaBucket | null;
  buckets?: AntigravityQuotaBucket[];
}

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
  day: string;
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
  verifyVision: async (modelId: string) => {
    const res = await fetch(`${BACKEND_URL}/api/models/${encodeURIComponent(modelId)}/verify-vision`, {
      method: "POST",
    });
    const data = (await res.json()) as {
      modelId: string;
      vision: boolean | "unknown";
      note?: string;
      inconclusive?: boolean;
      error?: string;
    };
    if (!res.ok && !data.inconclusive) throw new Error(data.error || `verify-vision failed (${res.status})`);
    return data;
  },

  getAuthFiles: () => request<{ files: AuthFileEntry[] }>("/auth-files"),
  getUsage: () => request<UsageResponse>("/usage"),
  getUsageTokens: (days = 7) => request<UsageTokenSummary>(`/usage/tokens?days=${days}`),
  getCodexLimits: () => request<{ accounts: CodexUsageEntry[] }>("/usage/codex-limits"),
  getAntigravityLimits: () => request<{ accounts: AntigravityUsageEntry[] }>("/usage/antigravity-limits"),
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
