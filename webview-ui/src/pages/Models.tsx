import { useEffect, useState } from "react";
import { api, type ModelCapabilities, type ModelEntry } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { loadCustomGroups } from "../lib/custom-groups";
import { postSyncModels } from "../vscodeApi";

const PINNED_PROVIDERS = ["antigravity", "claude", "codex", "xai"];
const PROVIDER_LABELS: Record<string, string> = {
  antigravity: "Antigravity",
  claude: "Claude",
  codex: "Codex",
  xai: "xAI (Grok)",
  other: "Other",
};

function groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, T[]> {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    (acc[key] ||= []).push(item);
    return acc;
  }, {} as Record<K, T[]>);
}

export function Models() {
  const { data, mutate, isLoading } = usePolling(api.getModels, 15000);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("all");
  const [query, setQuery] = useState("");
  const [verifying, setVerifying] = useState<Record<string, boolean>>({});
  const [overriding, setOverriding] = useState<Record<string, boolean>>({});
  // Custom-provider grouping is set on the Providers page and stored in
  // localStorage (never sent to the backend) -- read it here too so a model
  // served by e.g. a "tokenrouter" custom provider shows under that label.
  const [customGroups, setCustomGroups] = useState<Record<string, string>>({});

  useEffect(() => {
    setCustomGroups(loadCustomGroups());
  }, []);

  function labelFor(provider: string): string {
    return PROVIDER_LABELS[provider] ?? customGroups[provider] ?? provider;
  }

  const models = data?.models ?? [];

  async function verifyModel(model: ModelEntry) {
    setVerifying((v) => ({ ...v, [model.id]: true }));
    try {
      await api.verifyVision(model.id);
      await mutate(undefined, true);
      postSyncModels();
    } catch (err) {
      mutate(
        (current) =>
          current && {
            ...current,
            models: current.models.map((m) => (m.id === model.id ? { ...m, capabilities: { ...m.capabilities, note: (err as Error).message } } : m)),
          },
        false
      );
    } finally {
      setVerifying((v) => ({ ...v, [model.id]: false }));
    }
  }

  async function setVisionOverride(model: ModelEntry, value: string) {
    if (overriding[model.id]) return;
    const vision = value === "auto" ? "auto" : value === "vision";
    setOverriding((current) => ({ ...current, [model.id]: true }));
    try {
      const result = await api.setVisionOverride(model.id, vision);
      mutate(
        (current) =>
          current && {
            ...current,
            models: current.models.map((m) => (m.id === model.id ? { ...m, capabilities: result.capabilities } : m)),
          },
        false
      );
      postSyncModels();
    } catch (err) {
      mutate(
        (current) =>
          current && {
            ...current,
            models: current.models.map((m) => (m.id === model.id ? { ...m, capabilities: { ...m.capabilities, note: (err as Error).message } } : m)),
          },
        false
      );
    } finally {
      setOverriding((current) => ({ ...current, [model.id]: false }));
      mutate(undefined, true);
    }
  }

  const presentProviders = new Set(models.map((m) => m.provider));
  const tabs = [
    "all",
    ...PINNED_PROVIDERS.filter((p) => presentProviders.has(p)),
    ...Array.from(presentProviders).filter((p) => !PINNED_PROVIDERS.includes(p)),
  ];

  const tabModels = activeTab === "all" ? models : models.filter((m) => m.provider === activeTab);
  const q = query.trim().toLowerCase();
  const visibleModels = q ? tabModels.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : tabModels;
  const grouped = groupBy(visibleModels, (m) => m.provider);

  async function applyEnabledIds(nextIds: string[]) {
    if (saving) return;
    const nextIdSet = new Set(nextIds);
    mutate(
      {
        models: models.map((m) => ({ ...m, enabled: nextIdSet.has(m.id) })),
        source: data?.source ?? "live",
        liveError: data?.liveError ?? null,
      },
      false
    );
    setSaving(true);
    try {
      await api.setEnabledModels(nextIds);
      postSyncModels();
    } finally {
      setSaving(false);
      mutate(undefined, true);
    }
  }

  function toggle(model: ModelEntry, enabled: boolean) {
    const nextIds = enabled ? [...models.filter((m) => m.enabled).map((m) => m.id), model.id] : models.filter((m) => m.enabled && m.id !== model.id).map((m) => m.id);
    return applyEnabledIds(nextIds);
  }

  function setGroupEnabled(items: ModelEntry[], enabled: boolean) {
    const groupIds = new Set(items.map((m) => m.id));
    const others = models.filter((m) => !groupIds.has(m.id) && m.enabled).map((m) => m.id);
    const nextIds = enabled ? [...others, ...items.map((m) => m.id)] : others;
    return applyEnabledIds(nextIds);
  }

  function setAllEnabled(enabled: boolean) {
    return applyEnabledIds(enabled ? models.map((m) => m.id) : []);
  }

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1>Models</h1>
          <p className="page-hint">
            Toggle which models get pushed into Copilot Chat's BYOK list. The extension picks these up automatically (or run
            "Renn Copilot: Sync Models" manually).
          </p>
        </div>
        <div className="btn-row">
          {saving && <span className="badge neutral">Saving...</span>}
          <button className="btn secondary" disabled={!models.length} onClick={() => setAllEnabled(false)}>
            Disable all
          </button>
          <button className="btn" disabled={!models.length} onClick={() => setAllEnabled(true)}>
            Enable all
          </button>
        </div>
      </div>

      <div className="tabs" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {tabs.map((tab) => {
            const count = tab === "all" ? models.length : models.filter((m) => m.provider === tab).length;
            return (
              <button key={tab} className={`btn secondary ${activeTab === tab ? "active" : ""}`} onClick={() => setActiveTab(tab)}>
                {tab === "all" ? "All" : labelFor(tab)} ({count})
              </button>
            );
          })}
        </div>
        {models.length > 0 && (
          <div className="search-box">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models..." />
          </div>
        )}
      </div>

      {isLoading && <p className="page-hint">Loading models...</p>}

      {!isLoading && !visibleModels.length && <p className="page-hint">{q ? "No models match your search." : "No models for this provider yet."}</p>}

      {!isLoading && data?.source === "empty" && (
        <div className="empty-hint">
          Couldn't fetch the live model list from CLIProxyAPI ({data.liveError || "is the server running and is at least one account logged in?"}). Start
          the server and log in to a provider, then this list will populate automatically.
        </div>
      )}

      {Object.entries(grouped).map(([provider, items]) => {
        const enabledCount = items.filter((m) => m.enabled).length;
        return (
          <div className="card" key={provider}>
            <div className="card-title">
              <span>
                {labelFor(provider)} <span className="card-desc">({enabledCount}/{items.length} enabled)</span>
              </span>
              <div className="btn-row">
                <button className="btn secondary" disabled={enabledCount === 0} onClick={() => setGroupEnabled(items, false)}>
                  Disable all
                </button>
                <button className="btn secondary" disabled={enabledCount === items.length} onClick={() => setGroupEnabled(items, true)}>
                  Enable all
                </button>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {items.map((m) => (
                <div className="model-row" key={m.id}>
                  <div>
                    <div className="model-row-name">{m.label}</div>
                    <div className="model-row-id">
                      {m.id} {m.thinking && "· thinking"}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <CapabilityBadge
                      capabilities={m.capabilities}
                      verifying={!!verifying[m.id]}
                      overriding={!!overriding[m.id]}
                      onRecheck={() => verifyModel(m)}
                      onOverride={(value) => setVisionOverride(m, value)}
                    />
                    <input type="checkbox" className="toggle" checked={m.enabled} disabled={saving} onChange={(e) => toggle(m, e.target.checked)} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <div className="empty-hint">
        After changing models here, reload VS Code and enable them via Copilot Chat's model picker → "Manage Models..." → click the eye icon. That last
        step has to be manual -- VS Code doesn't expose an API to enable BYOK models programmatically yet.
      </div>
    </div>
  );
}

function CapabilityBadge({
  capabilities,
  verifying,
  overriding,
  onRecheck,
  onOverride,
}: {
  capabilities: ModelCapabilities;
  verifying: boolean;
  overriding: boolean;
  onRecheck: () => void;
  onOverride: (value: string) => void;
}) {
  const { vision, source, note, checkedAt } = capabilities;
  const sourceLabel =
    source === "manual" ? "Manual" : source === "probe" ? "Verified" : source === "catalog" ? "Catalog" : source === "provider-metadata" ? "Provider" : "Unknown";
  const checkedLabel = checkedAt ? ` · checked ${new Date(checkedAt).toLocaleString()}` : "";
  const title = `${note || sourceLabel}${checkedLabel}`;
  const badge =
    vision === true ? (
      <span className="badge success" title={title}>
        Vision · {sourceLabel}
      </span>
    ) : vision === false ? (
      <span className="badge error" title={title}>
        No vision · {sourceLabel}
      </span>
    ) : (
      <span className="badge neutral" title={title}>
        Vision unknown
      </span>
    );

  return (
    <div className="capability-controls">
      {badge}
      <select
        className="capability-select"
        aria-label="Vision capability mode"
        title="Auto uses catalog metadata or a verified probe. Manual choices override both."
        value={source === "manual" ? (vision ? "vision" : "no-vision") : "auto"}
        disabled={verifying || overriding}
        onChange={(event) => onOverride(event.target.value)}
      >
        <option value="auto">Auto</option>
        <option value="vision">Vision</option>
        <option value="no-vision">No vision</option>
      </select>
      <button className="icon-recheck" title="Verify vision support (sends one real test request)" disabled={verifying || overriding} onClick={onRecheck}>
        {verifying ? "⟳" : "↻"}
      </button>
    </div>
  );
}
