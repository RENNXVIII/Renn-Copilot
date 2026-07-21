import { useEffect, useState } from "react";
import { api, type ApiKeyEntry, type AuthFileEntry, type OpenAiCompatEntry } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { useEmailReveal } from "../hooks/useEmailReveal";
import { loadCustomGroups, saveCustomGroups } from "../lib/custom-groups";
import { maskKey } from "../lib/utils";
import { Modal, ModalHeader, MaskedEmail } from "../components/Modal";
import { postOpenExternal } from "../vscodeApi";

const FIXED_PROVIDER_IDS = ["antigravity", "claude", "codex", "xai"] as const;
type FixedProviderId = (typeof FIXED_PROVIDER_IDS)[number];

const PROVIDER_CARDS: {
  id: FixedProviderId;
  label: string;
  description: string;
  // Every fixed provider except xai has a dedicated Management API key list
  // (gemini/claude/codex-key). xAI has none (see routes.js's findXaiEntry
  // doc comment) -- its card uses `isXai` to route "Add via API key" to a
  // different modal backed by a shared openai-compatibility entry instead.
  apiKey?: { label: string; getter: () => Promise<{ items: ApiKeyEntry[] }>; setter: (items: ApiKeyEntry[]) => Promise<{ items: ApiKeyEntry[] }> };
  isXai?: boolean;
  oauthDisabled?: boolean;
  oauthDisabledReason?: string;
  note?: string;
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
    note:
      'Anthropic now bills third-party OAuth usage as "extra usage" instead of plan quota: "Third-party apps now draw ' +
      'from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going." Add extra ' +
      "usage credit at claude.ai/settings/usage, or use \"Add via API key\" for separate (non-plan) billing instead.",
  },
  {
    id: "codex",
    label: "Codex (ChatGPT)",
    description: "Login with your ChatGPT account to use ChatGPT Codex models.",
    apiKey: { label: "Codex API Key", getter: api.getCodexKeys, setter: api.setCodexKeys },
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    description: "Login with your SuperGrok / X Premium+ account, or add a raw xAI API key.",
    isXai: true,
    note:
      "xAI login uses a device code, not a browser redirect: after clicking, a page opens where you approve the " +
      "code shown below (it's usually pre-filled from the link). This can take up to a few minutes to complete.",
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
  const [loginCodes, setLoginCodes] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [bannedUntil, setBannedUntil] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const [apiKeyModal, setApiKeyModal] = useState<(typeof PROVIDER_CARDS)[number]["apiKey"] | null>(null);
  const [xaiModalOpen, setXaiModalOpen] = useState(false);
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState("antigravity");
  const [customGroups, setCustomGroups] = useState<Record<string, string>>({});
  const [resetting, setResetting] = useState<Record<string, boolean>>({});
  const [restarting, setRestarting] = useState(false);
  const { revealed, toggle: toggleRevealed } = useEmailReveal();
  const [savingPrefix, setSavingPrefix] = useState<Record<string, boolean>>({});
  const { data: preferences, mutate: mutatePreferences } = usePolling(api.getPreferences, 30000);
  const claudeCoworkMode = Boolean(preferences?.claudeCoworkMode);
  const [savingCowork, setSavingCowork] = useState(false);
  // VS Code webviews often block/break window.confirm -- use an in-app modal instead.
  const [coworkConfirmOpen, setCoworkConfirmOpen] = useState(false);
  const [coworkSaveError, setCoworkSaveError] = useState<string | null>(null);
  // Visual-only preview while the confirm modal is open so the switch does not
  // feel "stuck" before the user confirms.
  const coworkSwitchOn = claudeCoworkMode || coworkConfirmOpen;

  function requestClaudeCoworkMode(next: boolean) {
    if (savingCowork) return;
    setCoworkSaveError(null);
    if (next) {
      if (claudeCoworkMode || coworkConfirmOpen) return;
      setCoworkConfirmOpen(true);
      return;
    }
    if (!claudeCoworkMode) {
      setCoworkConfirmOpen(false);
      return;
    }
    void applyClaudeCoworkMode(false);
  }

  async function applyClaudeCoworkMode(next: boolean) {
    if (savingCowork) return;
    setCoworkConfirmOpen(false);
    setCoworkSaveError(null);
    setSavingCowork(true);
    const previous = {
      revealEmails: preferences?.revealEmails ?? false,
      claudeCoworkMode,
    };
    mutatePreferences({ ...previous, claudeCoworkMode: next }, false);
    try {
      const result = await api.setPreferences({ claudeCoworkMode: next });
      // Old backends ignore unknown fields and only echo revealEmails -- treat
      // that as a hard failure so the switch does not silently snap back later.
      if (typeof result?.claudeCoworkMode !== "boolean") {
        throw new Error(
          "Backend is outdated and does not support Cowork mode. Run “Renn Copilot: Stop Backend”, then “Start Backend”, or reload the VS Code window."
        );
      }
      if (Boolean(result.claudeCoworkMode) !== next) {
        throw new Error("Backend did not persist Cowork mode. Restart the Renn backend and try again.");
      }
      mutatePreferences(
        {
          revealEmails: Boolean(result.revealEmails),
          claudeCoworkMode: Boolean(result.claudeCoworkMode),
        },
        false
      );
    } catch (err) {
      mutatePreferences(previous, false);
      const message = err instanceof Error ? err.message : String(err);
      setCoworkSaveError(message);
      console.error("Failed to save claudeCoworkMode", err);
    } finally {
      setSavingCowork(false);
    }
  }

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

  const geminiKeysQuery = usePolling(api.getGeminiKeys, 30000, serverRunning);
  const claudeKeysQuery = usePolling(api.getClaudeKeys, 30000, serverRunning);
  const codexKeysQuery = usePolling(api.getCodexKeys, 30000, serverRunning);
  const xaiKeyQuery = usePolling(api.getXaiKey, 30000, serverRunning);
  const apiKeyQueriesById: Record<string, typeof geminiKeysQuery> = {
    antigravity: geminiKeysQuery,
    claude: claudeKeysQuery,
    codex: codexKeysQuery,
  };
  const customQuery = usePolling(api.getOpenAiCompat, 30000, serverRunning);
  const customItems = customQuery.data?.items ?? [];
  const customGroupNames = Array.from(new Set(customItems.map((it) => customGroups[it.name] || "Ungrouped"))).filter(
    (g) => !FIXED_PROVIDER_IDS.includes(g as FixedProviderId)
  );
  const allGroups = [...PROVIDER_CARDS.map((p) => ({ id: p.id, label: p.label })), ...customGroupNames.map((g) => ({ id: g, label: g }))];
  const groupOptions = Array.from(new Set([...FIXED_PROVIDER_IDS, ...customGroupNames]));

  function countForGroup(id: string): number {
    if (id === "xai") {
      const oauthCount = data?.files?.filter((f) => f.provider === "xai").length ?? 0;
      const keyCount = xaiKeyQuery.data?.item?.["api-key-entries"]?.length ?? 0;
      return oauthCount + keyCount;
    }
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

  // CLIProxyAPI's Management API has no endpoint to re-validate a single
  // credential's `status` field on demand (confirmed against its docs) --
  // that field only seems to get refreshed when CLIProxyAPI itself restarts
  // and re-reads every auth file. So a stale "error" badge on an account
  // that's actually working again (e.g. after a quota issue resolved) can
  // only be cleared by restarting the whole server, not per-credential.
  async function restartServer() {
    setRestarting(true);
    try {
      await api.restart();
    } finally {
      setRestarting(false);
      mutate(undefined, true);
    }
  }

  // Gives a credential its own routable "<prefix>/<model-id>" ids so it can
  // be toggled independently from other credentials serving the same bare
  // model id (e.g. Antigravity and Claude Code both offering the identical
  // "claude-sonnet-4-6"). Only takes real effect once CLIProxyAPI's
  // force-model-prefix is on -- otherwise the bare id still pools this
  // credential in too. See model-catalog.js's buildModelList for how the
  // Models page resolves prefixed ids back to a provider.
  async function savePrefix(f: AuthFileEntry, prefix: string) {
    const trimmed = prefix.trim();
    if (trimmed === (f.prefix || "")) return;
    setSavingPrefix((s) => ({ ...s, [f.name]: true }));
    try {
      await api.setAuthFilePrefix(f.name, trimmed);
    } finally {
      setSavingPrefix((s) => ({ ...s, [f.name]: false }));
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

  async function startLogin(provider: FixedProviderId) {
    if (!serverRunning) return;
    setLoginStates((s) => ({ ...s, [provider]: "waiting" }));
    setLoginCodes((c) => ({ ...c, [provider]: "" }));
    try {
      const { url, state, userCode } = await api.startLogin(provider);
      if (userCode) setLoginCodes((c) => ({ ...c, [provider]: userCode }));
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

  // Shared by every fixed provider's OAuth account list (including xAI's --
  // extracted so the xai branch of renderGroupRows can reuse it instead of
  // duplicating this block).
  function renderOAuthAccountRow(f: AuthFileEntry) {
    return (
      <div key={f.name} className="cred-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
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
            <span
              className={`badge ${f.status === "ready" ? "success" : "neutral"}`}
              title={
                f.status !== "ready"
                  ? "Raw status reported by CLIProxyAPI -- can lag behind reality (e.g. still show \"error\" after a resolved quota issue) until CLIProxyAPI restarts."
                  : undefined
              }
            >
              {f.status}
            </span>
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
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="card-desc" style={{ minWidth: 40 }}>
            Prefix
          </span>
          <input
            className="text-input"
            style={{ width: 140 }}
            placeholder="none"
            defaultValue={f.prefix || ""}
            key={`${f.name}-${f.prefix || ""}`}
            onBlur={(e) => savePrefix(f, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            disabled={savingPrefix[f.name]}
          />
          <span className="card-desc" title="When set, this account's models get a distinct '<prefix>/<model-id>' id on the Models page, addressable independently from other accounts serving the same bare model id.">
            {f.prefix ? `→ models appear as "${f.prefix}/<model-id>"` : "optional -- namespaces this account's models"}
          </span>
        </div>
      </div>
    );
  }

  async function removeXaiKey(index: number) {
    const entry = xaiKeyQuery.data?.item;
    if (!entry) return;
    const nextEntries = (entry["api-key-entries"] || []).filter((_, i) => i !== index);
    await api.setXaiKey(nextEntries.length ? { ...entry, "api-key-entries": nextEntries } : null);
    xaiKeyQuery.mutate(undefined, true);
  }

  function renderGroupRows() {
    const isFixed = FIXED_PROVIDER_IDS.includes(selectedGroup as FixedProviderId);
    if (isFixed) {
      const oauthAccounts = data?.files?.filter((f) => f.provider === selectedGroup) ?? [];

      // xAI has no dedicated Management API key list -- its "keys" live in one
      // shared openai-compatibility entry instead (see routes.js's
      // findXaiEntry), so it needs its own rendering branch rather than the
      // generic apiKeyQueriesById lookup the other three providers use.
      if (selectedGroup === "xai") {
        const xaiEntry = xaiKeyQuery.data?.item;
        const keyEntries = xaiEntry?.["api-key-entries"] ?? [];
        const empty = !oauthAccounts.length && !keyEntries.length;
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
            {oauthAccounts.map(renderOAuthAccountRow)}
            {keyEntries.map((k, i) => (
              <div key={`xai-key-${i}`} className="cred-row">
                <div>
                  <div style={{ fontFamily: "var(--vscode-editor-font-family, monospace)" }}>{maskKey(k["api-key"])}</div>
                  <div className="cred-row-sub">
                    xAI API Key
                    {xaiEntry?.models?.length
                      ? ` · models: ${xaiEntry.models.map((m) => m.alias || m.name).join(", ")}`
                      : " · no model IDs set -- won't show up on the Models page"}
                  </div>
                </div>
                <button className="btn secondary" onClick={() => removeXaiKey(i)}>
                  Remove
                </button>
              </div>
            ))}
          </>
        );
      }

      const keyQuery = apiKeyQueriesById[selectedGroup];
      const keyItems = keyQuery?.data?.items ?? [];
      const keyConfig = PROVIDER_CARDS.find((p) => p.id === selectedGroup)!.apiKey!;
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
          {oauthAccounts.map(renderOAuthAccountRow)}
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
              {p.note && (
                <p className="card-desc" style={{ color: "var(--vscode-editorWarning-foreground, #cca700)" }}>
                  {p.note}
                </p>
              )}
              {p.id === "claude" && (
                <div
                  className={`cowork-toggle-card${coworkSwitchOn ? " is-on" : ""}${coworkConfirmOpen ? " is-pending" : ""}`}
                >
                  <button
                    type="button"
                    className="cowork-toggle-row"
                    disabled={savingCowork}
                    aria-pressed={claudeCoworkMode}
                    onClick={() => requestClaudeCoworkMode(!coworkSwitchOn)}
                  >
                    <div className="cowork-toggle-copy">
                      <div className="cowork-toggle-title">
                        Cowork-style agent requests
                        {claudeCoworkMode && <span className="badge neutral cowork-badge">On · own risk</span>}
                      </div>
                      <div className="card-desc">
                        Route Claude chat with a Cowork/agent fingerprint and remap VS Code tools to
                        Claude Code names (unmapped tools are dropped). Off by default.
                      </div>
                    </div>
                    <span
                      className={`toggle-switch${coworkSwitchOn ? " is-on" : ""}${savingCowork ? " is-busy" : ""}`}
                      role="switch"
                      aria-checked={claudeCoworkMode}
                      aria-label="Cowork-style agent requests"
                    />
                  </button>
                  {claudeCoworkMode && (
                    <p className="card-desc cowork-risk-banner">
                      Unofficial fingerprinting + tool remap may affect TOS, billing, account health,
                      or agent capabilities. Not a guarantee of plan-limit billing.
                    </p>
                  )}
                  {coworkSaveError && (
                    <p className="card-desc cowork-error-banner" role="alert">
                      {coworkSaveError}
                    </p>
                  )}
                </div>
              )}
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
              {state === "waiting" && (
                <span className="badge neutral">
                  Waiting for browser...{loginCodes[p.id] ? ` code: ${loginCodes[p.id]}` : ""}
                </span>
              )}
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
                <button
                  className="btn secondary"
                  style={{ width: "100%" }}
                  onClick={() => (p.isXai ? setXaiModalOpen(true) : setApiKeyModal(p.apiKey!))}
                  disabled={!serverRunning}
                >
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
          <div className="btn-row">
            <button
              className="btn secondary"
              disabled={restarting || !serverRunning}
              title="CLIProxyAPI only re-checks a credential's status when it restarts -- use this if a badge below still says 'error' even though the account works fine now."
              onClick={restartServer}
            >
              {restarting ? "Restarting..." : "Restart CLIProxyAPI"}
            </button>
            <button className="btn secondary" onClick={() => toggleRevealed()}>
              {revealed ? "Hide emails" : "Reveal emails"}
            </button>
          </div>
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

      <Modal open={xaiModalOpen} onClose={() => setXaiModalOpen(false)}>
        <XaiApiKeyModalContent onClose={() => setXaiModalOpen(false)} />
      </Modal>

      <Modal open={customModalOpen} onClose={() => setCustomModalOpen(false)}>
        <CustomProviderModalContent onClose={() => setCustomModalOpen(false)} groupOptions={groupOptions} onAssignGroup={assignCustomGroup} />
      </Modal>

      <Modal open={coworkConfirmOpen} onClose={() => !savingCowork && setCoworkConfirmOpen(false)}>
        <div className="cowork-modal">
          <div className="cowork-modal-hero">
            <div className="cowork-modal-kicker">Claude provider</div>
            <div className="cowork-modal-title">Enable Cowork-style requests?</div>
            <p className="cowork-modal-lead">
              Claude chat will look like a Cowork / agent client. This is unofficial and optional.
            </p>
            <button
              type="button"
              className="modal-close cowork-modal-close"
              disabled={savingCowork}
              onClick={() => setCoworkConfirmOpen(false)}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="cowork-modal-callout" role="note">
            <div className="cowork-modal-callout-title">At your own risk</div>
            <ul className="cowork-modal-list">
              <li>May affect billing classification or rate limits</li>
              <li>May conflict with Anthropic terms or account standing</li>
              <li>You can turn this off anytime</li>
            </ul>
          </div>

          <details className="cowork-modal-details">
            <summary>What changes technically</summary>
            <p>
              Renn stamps Cowork-style entrypoint + workload on Claude requests so CLIProxyAPI cloaking can embed
              <code> cc_entrypoint=cowork</code> / <code>cc_workload=cowork</code>.
            </p>
          </details>

          <div className="cowork-modal-actions">
            <button className="btn secondary" disabled={savingCowork} onClick={() => setCoworkConfirmOpen(false)}>
              Not now
            </button>
            <button className="btn btn-danger" disabled={savingCowork} onClick={() => void applyClaudeCoworkMode(true)}>
              {savingCowork ? "Enabling..." : "I understand — enable"}
            </button>
          </div>
        </div>
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

// xAI has no dedicated Management API key list (see routes.js's findXaiEntry
// doc comment) -- this reads/writes one shared openai-compatibility entry
// pinned to api.x.ai instead. Unlike Gemini/Claude/Codex's key modal, model
// IDs aren't auto-discovered for this path (CLIProxyAPI only knows which
// models a generic openai-compatibility endpoint serves from what's declared
// here), so this modal also collects them -- same requirement as the Custom
// provider modal below, just pre-scoped to xAI's fixed base URL.
function XaiApiKeyModalContent({ onClose }: { onClose: () => void }) {
  const { data, mutate, isLoading } = usePolling(api.getXaiKey, 30000);
  const entry = data?.item ?? null;
  const keyEntries = entry?.["api-key-entries"] ?? [];
  const [apiKey, setApiKey] = useState("");
  const [modelIds, setModelIds] = useState(() => (entry?.models ?? []).map((m) => m.alias || m.name).join(", "));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setModelIds((entry?.models ?? []).map((m) => m.alias || m.name).join(", "));
  }, [entry?.models]);

  function parsedModels() {
    return modelIds
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .map((m) => ({ name: m }));
  }

  async function addEntry() {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      const models = parsedModels();
      await api.setXaiKey({
        name: "xai",
        "base-url": "https://api.x.ai/v1",
        "api-key-entries": [...keyEntries, { "api-key": apiKey.trim() }],
        ...(models.length ? { models } : {}),
      });
      setApiKey("");
    } finally {
      setSaving(false);
      mutate(undefined, true);
    }
  }

  async function removeKey(index: number) {
    setSaving(true);
    try {
      const nextEntries = keyEntries.filter((_, i) => i !== index);
      await api.setXaiKey(nextEntries.length ? { ...entry!, "api-key-entries": nextEntries } : null);
    } finally {
      setSaving(false);
      mutate(undefined, true);
    }
  }

  async function saveModelIds() {
    if (!keyEntries.length) return;
    setSaving(true);
    try {
      const models = parsedModels();
      await api.setXaiKey({ ...entry!, name: "xai", "base-url": "https://api.x.ai/v1", ...(models.length ? { models } : { models: [] }) });
    } finally {
      setSaving(false);
      mutate(undefined, true);
    }
  }

  return (
    <>
      <ModalHeader title="xAI API Key" description={`${keyEntries.length} key${keyEntries.length === 1 ? "" : "s"} configured`} onClose={onClose} />
      {isLoading && <p className="card-desc">Loading...</p>}
      {!isLoading && !keyEntries.length && <p className="card-desc">No keys yet.</p>}
      {keyEntries.map((k, i) => (
        <div key={i} className="cred-row">
          <div style={{ fontFamily: "var(--vscode-editor-font-family, monospace)" }}>{maskKey(k["api-key"])}</div>
          <button className="btn secondary" disabled={saving} onClick={() => removeKey(i)}>
            Remove
          </button>
        </div>
      ))}
      <div className="field" style={{ border: "1px dashed var(--vscode-panel-border)", borderRadius: 4, padding: 10, gap: 8 }}>
        <div className="field">
          <label className="field-label">API key</label>
          <input className="text-input" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="xai-..." />
        </div>
        <div className="field">
          <label className="field-label">Model IDs (comma-separated)</label>
          <input className="text-input" value={modelIds} onChange={(e) => setModelIds(e.target.value)} placeholder="grok-4.3, grok-4-fast" />
          <p className="card-desc">
            Shared across all keys above -- CLIProxyAPI needs this to know which models this endpoint serves; without it they won't show up on the Models page.
          </p>
        </div>
        <div className="btn-row">
          <button className="btn" disabled={saving || !apiKey.trim()} onClick={addEntry}>
            Add key
          </button>
          {keyEntries.length > 0 && (
            <button className="btn secondary" disabled={saving} onClick={saveModelIds}>
              Save model IDs
            </button>
          )}
        </div>
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
