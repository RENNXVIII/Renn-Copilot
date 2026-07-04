import { useEffect, useState } from "react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";

const STRATEGY_OPTIONS = [
  { id: "round-robin" as const, label: "Round-robin", description: "Cycle through every matching credential evenly." },
  { id: "fill-first" as const, label: "Fill-first", description: "Exhaust one credential's quota before moving to the next." },
];

export function Config() {
  const { data, isLoading } = usePolling(api.getConfigYaml, 60000);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const { data: routing, mutate: mutateRouting } = usePolling(api.getRoutingStrategy, 60000);
  const [routingSaving, setRoutingSaving] = useState(false);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  async function save() {
    setSaving(true);
    try {
      await api.putConfigYaml(draft);
      mutateRouting(undefined, true);
    } finally {
      setSaving(false);
    }
  }

  async function setStrategy(strategy: "round-robin" | "fill-first") {
    if (routing?.strategy === strategy) return;
    setRoutingSaving(true);
    try {
      await api.setRoutingStrategy(strategy);
      mutateRouting(undefined, true);
      const fresh = await api.getConfigYaml();
      setDraft(fresh);
    } finally {
      setRoutingSaving(false);
    }
  }

  return (
    <div className="page">
      <div>
        <h1>Config</h1>
        <p className="page-hint">Raw config.yaml, edited through CLIProxyAPI's Management API. Validated server-side before saving.</p>
      </div>

      <div className="card">
        <div className="card-title">Routing strategy</div>
        <div className="card-desc">How CLIProxyAPI picks among multiple matching credentials for a request.</div>
        <div style={{ display: "flex", gap: 10 }}>
          {STRATEGY_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              disabled={routingSaving}
              onClick={() => setStrategy(opt.id)}
              className={`strategy-option ${routing?.strategy === opt.id ? "selected" : ""}`}
            >
              <div style={{ fontWeight: 600 }}>{opt.label}</div>
              <div className="card-desc">{opt.description}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">config.yaml</div>
        <div className="card-desc">Be careful: this replaces the entire file. Contains plaintext API keys -- hidden by default.</div>
        {isLoading ? (
          <p className="card-desc">Loading...</p>
        ) : (
          <div className="config-editor-wrap">
            <textarea className={`config-editor ${revealed ? "" : "blurred"}`} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} readOnly={!revealed} tabIndex={revealed ? undefined : -1} />
            {!revealed && (
              <div className="reveal-overlay">
                <button className="btn secondary" onClick={() => setRevealed(true)}>
                  Click to reveal & edit
                </button>
              </div>
            )}
          </div>
        )}
        <div className="btn-row">
          <button className="btn" disabled={saving || !revealed || draft === data} onClick={save}>
            {saving ? "Saving..." : "Save"}
          </button>
          {revealed && (
            <button className="btn secondary" disabled={saving || draft === data} onClick={() => data && setDraft(data)}>
              Discard changes
            </button>
          )}
          {revealed && (
            <button className="btn secondary" onClick={() => setRevealed(false)}>
              Hide
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
