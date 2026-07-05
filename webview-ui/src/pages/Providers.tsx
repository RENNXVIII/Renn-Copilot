import { useEffect, useState } from "react";
import { api, type ApiKeyEntry, type AuthFileEntry, type OpenAiCompatEntry } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { useEmailReveal } from "../hooks/useEmailReveal";
import { loadCustomGroups, saveCustomGroups } from "../lib/custom-groups";
import { maskKey } from "../lib/utils";
import { Modal, ModalHeader, MaskedEmail } from "../components/Modal";
import { postOpenExternal } from "../vscodeApi";

const PROVIDER_CARDS: {
  id: "antigravity" | "claude" | "codex";
  label: string;
  description: string;
  apiKey: { label: string; getter: () => Promise<{ items: ApiKeyEntry[] }>; setter: (items: ApiKeyEntry[]) => Promise<{ items: ApiKeyEntry[] }> };
  oauthDisabled?: boolean;
  oauthDisabledReason?: string;
}[] = [
  {
    id: "antigravity",
    label: "Antigravity (Google)",
    description: "Login via Google to access Antigravity's Claude + Gemini models.",
    apiKey: { label: "Gemini API Key", getter: api.getGeminiKeys, setter: api.setGeminiKeys },
  },
  {
    id: "claude",
    label: "Claude / Claude Code",
    description: "Login with your Claude.ai / Claude Code account (Anthropic OAuth).",
    apiKey: { label: "Claude API Key", getter: api.getClaudeKeys, setter: api.setClaudeKeys },
    oauthDisabled: true,
    oauthDisabledReason:
      'Anthropic now bills third-party OAuth usage as "extra usage" instead of plan quota -- disabled here until that\'s resolved. Use "Add via API key" instead.',
  },
  {
    id: "codex",
    label: "Codex (ChatGPT)",
    description: "Login with your ChatGPT account to use ChatGPT Codex models.",
    apiKey: { label: "Codex API Key", getter: api.getCodexKeys, setter: api.setCodexKeys },
  },
];

type LoginState = "idle" | "waiting" | "ok" | "error";
const BAN_STORAGE_KEY = "renn-copilot:provider-bans";

function parseBanDeadline(message: string): number | null {
  const match = message.match(/try again in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
  return totalMs > 0 ? Date.now() + totalMs : null;
}

function loadBans(): Record<string, number> {
  try {
    return JSON.parse(window.localStorage.getItem(BAN_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveBans(bans: Record<string, number>) {
  window.localStorage.setItem(BAN_STORAGE_KEY, JSON.stringify(bans));
}

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

export function Providers() {
  const { data: status } = usePolling(api.getStatus, 4000);
  const serverRunning = status?.running ?? false;
  const { data, mutate } = usePolling(api.getAuthFiles, 8000, serverRunning);
  const [loginStates, setLoginStates] = useState<Record<string, LoginState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [bannedUntil, setBannedUntil] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const [apiKeyModal, setApiKeyModal] = useState<(typeof PROVIDER_CARDS)[number]["apiKey"] | null>(null);
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState("antigravity");
  const [customGroups, setCustomGroups] = useState<Record<string, string>>({});
  const [resetting, setResetting] = useState<Record<string, boolean>>({});
  const { revealed, toggle: toggleRevealed } = useEmailReveal();

  useEffect(() => {
    setBannedUntil(loadBans());
    setCustomGroups(loadCustomGroups());
  }, []);

  function assignCustomGroup(name: string, group: string) {
    setCustomGroups((g) => {
      const next = { ...g, [name]: group };
      saveCustomGroups(next);
      return next;
    });
  }

  const geminiKeysQuery = usePolling(PROVIDER_CARDS[0].apiKey.getter, 30000, serverRunning);
  const claudeKeysQuery = usePolling(PROVIDER_CARDS[1].apiKey.getter, 30000, serverRunning);
  const codexKeysQuery = usePolling(PROVIDER_CARDS[2].apiKey.getter, 30000, serverRunning);
  const apiKeyQueriesById: Record<string, typeof geminiKeysQuery> = {
    antigravity: geminiKeysQuery,
    claude: claudeKeysQuery,
    codex: codexKeysQuery,
  };
  const customQuery = usePolling(api.getOpenAiCompat, 30000, serverRunning);
  const customItems = customQuery.data?.items ?? [];
  const customGroupNames = Array.from(new Set(customItems.map((it) => customGroups[it.name] || "Ungrouped"))).filter(
    (g) => !["antigravity", "claude", "codex"].includes(g)
  );
  const allGroups = [...PROVIDER_CARDS.map((p) => ({ id: p.id, label: p.label })), ...customGroupNames.map((g) => ({ id: g, label: g }))];
  const groupOptions = Array.from(new Set(["antigravity", "claude", "codex", ...customGroupNames]));

  function countForGroup(id: string): number {
    if (id === "antigravity" || id === "claude" || id === "codex") {
      const oauthCount = data?.files?.filter((f) => f.provider === id).length ?? 0;
      const keyCount = apiKeyQueriesById[id]?.data?.items?.length ?? 0;
      return oauthCount + keyCount;
    }
    return customItems.filter((it) => (customGroups[it.name] || "Ungrouped") === id).length;
  }

  async function toggleActive(f: AuthFileEntry, active: boolean) {
    const disabled = !active;
    mutate(data ? { files: data.files.map((x) => (x.name === f.name ? { ...x, disabled } : x)) } : data, false);
    try {
      await api.setAuthFileDisabled(f.name, disabled);
    } finally {
      mutate(undefined, true);
    }
  }

  async function bulkSetOAuthDisabled(accounts: AuthFileEntry[], disabled: boolean) {
    const targets = accounts.filter((f) => !!f.disabled !== disabled);
    if (!targets.length) return;
    try {
      await Promise.all(targets.map((f) => api.setAuthFileDisabled(f.name, disabled)));
    } finally {
      mutate(undefined, true);
    }
  }

  async function bulkSetCustomDisabled(items: { entry: OpenAiCompatEntry; idx: number }[], disabled: boolean) {
    const targets = items.filter(({ entry }) => !!entry.disabled !== disabled);
    if (!targets.length) return;
    const idxSet = new Set(targets.map((t) => t.idx));
    try {
      await api.setOpenAiCompat(customItems.map((it, i) => (idxSet.has(i) ? { ...it, disabled } : it)));
    } finally {
      customQuery.mutate(undefined, true);
    }
  }

  async function handleResetQuota(f: AuthFileEntry) {
    if (!f.auth_index) return;
    setResetting((s) => ({ ...s, [f.name]: true }));
    try {
      await api.resetQuota(f.auth_index);
    } finally {
      setResetting((s) => ({ ...s, [f.name]: false }));
      mutate(undefined, true);
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
      postOpenExternal(url);
      pollLogin(provider, state);
    } catch (err: any) {
      setLoginStates((s) => ({ ...s, [provider]: "error" }));
      setErrors((e) => ({ ...e, [provider]: err.message }));
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
          mutate(undefined, true);
        } else if (res.status === "error") {
          clearInterval(interval);
          setLoginStates((s) => ({ ...s, [provider]: "error" }));
          setErrors((e) => ({ ...e, [provider]: res.error || "Authentication failed" }));
        }
      } catch {
        // keep polling; transient network errors are expected while CLIProxyAPI restarts
      }
    }, 2000);
    setTimeout(() => clearInterval(interval), 5 * 60 * 1000);
  }

  useEffect(() => {
    const anyBanned = Object.values(bannedUntil).some((t) => t > now);
    if (!anyBanned) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [bannedUntil, now]);

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
          {empty && <p className="card-desc">No credentials in this group yet.</p>}
          {oauthAccounts.length > 1 && (
            <div className="btn-row" style={{ justifyContent: "flex-end" }}>
              <button className="btn secondary" disabled={oauthAccounts.every((f) => !f.disabled)} onClick={() => bulkSetOAuthDisabled(oauthAccounts, false)}>
                Enable all
              </button>
              <button className="btn secondary" disabled={oauthAccounts.every((f) => !!f.disabled)} onClick={() => bulkSetOAuthDisabled(oauthAccounts, true)}>
                Disable all
              </button>
            </div>
          )}
          {oauthAccounts.map((f) => (
            <div key={f.name} className="cred-row">
              <div>
                <div>{f.email ? <MaskedEmail email={f.email} revealed={revealed} /> : f.name}</div>
                <div className="cred-row-sub">OAuth · {f.provider}</div>
              </div>
              <div className="btn-row" style={{ alignItems: "center" }}>
                {f.unavailable && (
                  <span className="badge neutral">
                    Quota exceeded{formatNextRetry(f.next_retry_after) ? ` · retry ~${formatNextRetry(f.next_retry_after)}` : ""}
                  </span>
                )}
                <span className={`badge ${f.status === "ready" ? "success" : "neutral"}`}>{f.status}</span>
                <span className="card-desc">{f.disabled ? "Inactive" : "Active"}</span>
                <input type="checkbox" className="toggle" checked={!f.disabled} onChange={(e) => toggleActive(f, e.target.checked)} />
                <button
                  className="btn secondary"
                  disabled={!f.auth_index || resetting[f.name]}
                  title={!f.auth_index ? "No auth_index reported for this credential" : undefined}
                  onClick={() => handleResetQuota(f)}
                >
                  {resetting[f.name] ? "Resetting..." : "Reset Quota"}
                </button>
                <button className="btn secondary" onClick={() => api.deleteAuthFile(f.name).then(() => mutate(undefined, true))}>
                  Remove
                </button>
              </div>
            </div>
          ))}
          {keyItems.map((entry, i) => (
            <div key={`key-${i}`} className="cred-row">
              <div>
                <div style={{ fontFamily: "var(--vscode-editor-font-family, monospace)" }}>{maskKey(entry["api-key"])}</div>
                <div className="cred-row-sub">
                  {keyConfig.label}
                  {entry["base-url"] ? ` · ${entry["base-url"]}` : ""}
                </div>
              </div>
              <button
                className="btn secondary"
                onClick={async () => {
                  await keyConfig.setter(keyItems.filter((_, idx) => idx !== i));
                  keyQuery?.mutate(undefined, true);
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </>
      );
    }

    const groupItems = customItems.map((entry, idx) => ({ entry, idx })).filter(({ entry }) => (customGroups[entry.name] || "Ungrouped") === selectedGroup);
    return (
      <>
        {!groupItems.length && <p className="card-desc">No credentials in this group yet.</p>}
        {groupItems.length > 1 && (
          <div className="btn-row" style={{ justifyContent: "flex-end" }}>
            <button className="btn secondary" disabled={groupItems.every(({ entry }) => !entry.disabled)} onClick={() => bulkSetCustomDisabled(groupItems, false)}>
              Enable all
            </button>
            <button className="btn secondary" disabled={groupItems.every(({ entry }) => !!entry.disabled)} onClick={() => bulkSetCustomDisabled(groupItems, true)}>
              Disable all
            </button>
          </div>
        )}
        {groupItems.map(({ entry, idx }) => (
          <div key={entry.name} className="cred-row">
            <div>
              <div>
                {entry.name} {entry.disabled && <span className="badge neutral">disabled</span>}
              </div>
              <div className="cred-row-sub">{entry["base-url"]}</div>
              {entry["api-key-entries"]?.[0] && <div className="cred-row-sub">{maskKey(entry["api-key-entries"][0]["api-key"])}</div>}
            </div>
            <div className="btn-row">
              <button
                className="btn secondary"
                onClick={async () => {
                  await api.setOpenAiCompat(customItems.map((it, i) => (i === idx ? { ...it, disabled: !it.disabled } : it)));
                  customQuery.mutate(undefined, true);
                }}
              >
                {entry.disabled ? "Enable" : "Disable"}
              </button>
              <button
                className="btn secondary"
                onClick={async () => {
                  await api.setOpenAiCompat(customItems.filter((_, i) => i !== idx));
                  customQuery.mutate(undefined, true);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </>
    );
  }

  return (
    <div className="page">
      <div>
        <h1>Providers & Login</h1>
        <p className="page-hint">
          Connect each provider via OAuth, or add a raw API key instead. Tokens and keys are stored by CLIProxyAPI under its auth directory.
        </p>
      </div>

      {!serverRunning && <div className="empty-hint">CLIProxyAPI isn't running yet, so login can't reach its Management API. Go to Overview and click Start first.</div>}

      <div className="grid">
        {PROVIDER_CARDS.map((p) => {
          const state = loginStates[p.id] ?? "idle";
          const banDeadline = bannedUntil[p.id];
          const isBanned = !!banDeadline && banDeadline > now;
          return (
            <div className="card" key={p.id}>
              <div className="card-title">
                <span>{p.label}</span>
                {p.oauthDisabled && <span className="badge neutral">Maintenance</span>}
              </div>
              <div className="card-desc">{p.description}</div>
              {p.oauthDisabled && <p className="card-desc">{p.oauthDisabledReason}</p>}
              {isBanned ? (
                <p className="card-desc" style={{ color: "var(--vscode-errorForeground)" }}>
                  Rate-limited by the provider — retry in {formatRemaining(banDeadline - now)}
                </p>
              ) : (
                state === "error" && (
                  <p className="card-desc" style={{ color: "var(--vscode-errorForeground)" }}>
                    {errors[p.id]}
                  </p>
                )
              )}
              {state === "ok" && <span className="badge success">Logged in</span>}
              {state === "waiting" && <span className="badge neutral">Waiting for browser...</span>}
              <div className="btn-row" style={{ flexDirection: "column" }}>
                <button
                  className="btn"
                  style={{ width: "100%" }}
                  onClick={() => startLogin(p.id)}
                  disabled={state === "waiting" || isBanned || !serverRunning || p.oauthDisabled}
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
                </button>
                <button className="btn secondary" style={{ width: "100%" }} onClick={() => setApiKeyModal(p.apiKey)} disabled={!serverRunning}>
                  Add via API key
                </button>
              </div>
            </div>
          );
        })}

        <div className="card">
          <div className="card-title">Custom provider</div>
          <div className="card-desc">OpenAI-compatible endpoint -- GLM, Kimi/Moonshot, or anything else that speaks the OpenAI chat-completions API.</div>
          <button className="btn secondary" style={{ width: "100%" }} onClick={() => setCustomModalOpen(true)} disabled={!serverRunning}>
            Add custom provider
          </button>
        </div>
      </div>

      <div className="empty-hint">
        Gemini CLI, Qwen, and iFlow don't expose an OAuth URL through CLIProxyAPI's Management API yet — authenticate those via the CLIProxyAPI CLI directly, then
        they'll show up below.
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <div className="card-title">Stored credentials</div>
            <div className="card-desc">Accounts and keys CLIProxyAPI currently has, grouped by provider.</div>
          </div>
          <button className="btn secondary" onClick={() => toggleRevealed()}>
            {revealed ? "Hide emails" : "Reveal emails"}
          </button>
        </div>
        <div className="credentials-panel">
          <div className="credentials-sidebar">
            {allGroups.map((g) => (
              <button key={g.id} className={selectedGroup === g.id ? "active" : ""} onClick={() => setSelectedGroup(g.id)} title={g.label}>
                <span>{g.label}</span>
                <span>{countForGroup(g.id)}</span>
              </button>
            ))}
          </div>
          <div className="credentials-body">{renderGroupRows()}</div>
        </div>
      </div>

      <Modal open={apiKeyModal !== null} onClose={() => setApiKeyModal(null)}>
        {apiKeyModal && <ApiKeyModalContent label={apiKeyModal.label} getter={apiKeyModal.getter} setter={apiKeyModal.setter} onClose={() => setApiKeyModal(null)} />}
      </Modal>

      <Modal open={customModalOpen} onClose={() => setCustomModalOpen(false)}>
        <CustomProviderModalContent onClose={() => setCustomModalOpen(false)} groupOptions={groupOptions} onAssignGroup={assignCustomGroup} />
      </Modal>
    </div>
  );
}

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
  const { data, mutate, isLoading } = usePolling(getter, 30000);
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
      mutate(undefined, true);
    }
  }

  async function removeEntry(index: number) {
    setSaving(true);
    try {
      await setter(items.filter((_, i) => i !== index));
    } finally {
      setSaving(false);
      mutate(undefined, true);
    }
  }

  return (
    <>
      <ModalHeader title={label} description={`${items.length} key${items.length === 1 ? "" : "s"} configured`} onClose={onClose} />
      {isLoading && <p className="card-desc">Loading...</p>}
      {!isLoading && !items.length && <p className="card-desc">No keys yet.</p>}
      {items.map((entry, i) => (
        <div key={i} className="cred-row">
          <div>
            <div style={{ fontFamily: "var(--vscode-editor-font-family, monospace)" }}>{maskKey(entry["api-key"])}</div>
            {entry["base-url"] && <div className="cred-row-sub">{entry["base-url"]}</div>}
          </div>
          <button className="btn secondary" disabled={saving} onClick={() => removeEntry(i)}>
            Remove
          </button>
        </div>
      ))}
      <div className="field" style={{ border: "1px dashed var(--vscode-panel-border)", borderRadius: 4, padding: 10, gap: 8 }}>
        <div className="field">
          <label className="field-label">API key</label>
          <input className="text-input" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
        </div>
        <div className="field">
          <label className="field-label">Base URL (optional)</label>
          <input className="text-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="leave blank for default" />
        </div>
        <button className="btn" style={{ alignSelf: "flex-start" }} disabled={saving || !apiKey.trim()} onClick={addEntry}>
          Add
        </button>
      </div>
    </>
  );
}

function CustomProviderModalContent({
  onClose,
  groupOptions,
  onAssignGroup,
}: {
  onClose: () => void;
  groupOptions: string[];
  onAssignGroup: (name: string, group: string) => void;
}) {
  const { data, mutate, isLoading } = usePolling(api.getOpenAiCompat, 30000);
  const items = data?.items ?? [];
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [group, setGroup] = useState("");
  const [modelIds, setModelIds] = useState("");
  const [saving, setSaving] = useState(false);

  async function addEntry() {
    if (!name.trim() || !baseUrl.trim() || !apiKey.trim() || !group.trim()) return;
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
      onAssignGroup(entry.name, group.trim());
      setName("");
      setBaseUrl("");
      setApiKey("");
      setGroup("");
      setModelIds("");
    } finally {
      setSaving(false);
      mutate(undefined, true);
    }
  }

  async function removeEntry(index: number) {
    setSaving(true);
    try {
      await api.setOpenAiCompat(items.filter((_, i) => i !== index));
    } finally {
      setSaving(false);
      mutate(undefined, true);
    }
  }

  async function toggleDisabled(index: number, disabled: boolean) {
    setSaving(true);
    try {
      await api.setOpenAiCompat(items.map((it, i) => (i === index ? { ...it, disabled } : it)));
    } finally {
      setSaving(false);
      mutate(undefined, true);
    }
  }

  return (
    <>
      <ModalHeader title="Custom provider" description="GLM, Kimi/Moonshot, or any other endpoint that speaks the OpenAI chat-completions API." onClose={onClose} />
      {isLoading && <p className="card-desc">Loading...</p>}
      {!isLoading && !items.length && <p className="card-desc">No custom providers yet.</p>}
      {items.map((entry, i) => (
        <div key={i} className="cred-row">
          <div>
            <div>
              {entry.name} {entry.disabled && <span className="badge neutral">disabled</span>}
            </div>
            <div className="cred-row-sub">{entry["base-url"]}</div>
            {entry["api-key-entries"]?.[0] && <div className="cred-row-sub">{maskKey(entry["api-key-entries"][0]["api-key"])}</div>}
            {entry.models?.length ? (
              <div className="cred-row-sub">Models: {entry.models.map((m) => m.alias || m.name).join(", ")}</div>
            ) : (
              <div className="cred-row-sub" style={{ color: "var(--vscode-editorWarning-foreground)" }}>
                No model IDs registered yet -- won't show up on the Models page.
              </div>
            )}
          </div>
          <div className="btn-row">
            <button className="btn secondary" disabled={saving} onClick={() => toggleDisabled(i, !entry.disabled)}>
              {entry.disabled ? "Enable" : "Disable"}
            </button>
            <button className="btn secondary" disabled={saving} onClick={() => removeEntry(i)}>
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="field" style={{ border: "1px dashed var(--vscode-panel-border)", borderRadius: 4, padding: 10, gap: 8 }}>
        <div className="field">
          <label className="field-label">Name</label>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="glm" />
        </div>
        <div className="field">
          <label className="field-label">Base URL</label>
          <input className="text-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
        </div>
        <div className="field">
          <label className="field-label">API key</label>
          <input className="text-input" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
        </div>
        <div className="field">
          <label className="field-label">Group</label>
          <input className="text-input" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="antigravity / claude / codex / or a new group" list="custom-provider-groups" />
          <datalist id="custom-provider-groups">
            {groupOptions.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label className="field-label">Model IDs (comma-separated)</label>
          <input className="text-input" value={modelIds} onChange={(e) => setModelIds(e.target.value)} placeholder="minimax-m3, glm-4-plus" />
          <p className="card-desc">Without this, CLIProxyAPI doesn't know which models this endpoint serves -- they won't show up on the Models page.</p>
        </div>
        <button className="btn" style={{ alignSelf: "flex-start" }} disabled={saving || !name.trim() || !baseUrl.trim() || !apiKey.trim() || !group.trim()} onClick={addEntry}>
          Add provider
        </button>
      </div>
    </>
  );
}
