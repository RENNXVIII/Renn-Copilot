import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { mergeConfigDraft } from "../lib/config-draft";

const STRATEGY_OPTIONS = [
  { id: "round-robin" as const, label: "Round-robin", description: "Cycle through every matching credential evenly." },
  { id: "fill-first" as const, label: "Fill-first", description: "Exhaust one credential's quota before moving to the next." },
];

export function Config() {
  const { data, isLoading, mutate: mutateConfig } = usePolling(api.getConfigYaml, 60000);
  const [draft, setDraft] = useState("");
  const baseline = useRef<string | null>(null);
  const draftRef = useRef("");
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const { data: routing, mutate: mutateRouting } = usePolling(api.getRoutingStrategy, 60000);
  const [routingSaving, setRoutingSaving] = useState(false);

  useEffect(() => {
    if (data === undefined) return;
    const next = mergeConfigDraft(draftRef.current, baseline.current, data);
    baseline.current = next.baseline;
    draftRef.current = next.draft;
    setDraft(next.draft);
  }, [data]);

  function editDraft(value: string) {
    draftRef.current = value;
    setDraft(value);
  }

  async function save() {
    const submitted = draftRef.current;
    setSaving(true);
    try {
      await api.putConfigYaml(submitted);
      baseline.current = submitted;
      mutateConfig(submitted, false);
      mutateRouting(undefined, true);
    } finally {
      setSaving(false);
    }
  }

  async function setStrategy(strategy: "round-robin" | "fill-first") {
    if (routing?.strategy === strategy) return;
    if (draftRef.current !== baseline.current) return;
    setRoutingSaving(true);
    try {
      await api.setRoutingStrategy(strategy);
      mutateRouting(undefined, true);
      const fresh = await api.getConfigYaml();
      const next = mergeConfigDraft(draftRef.current, baseline.current, fresh);
      baseline.current = next.baseline;
      editDraft(next.draft);
      mutateConfig(fresh, false);
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
              disabled={routingSaving || draft !== baseline.current}
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
            <textarea className={`config-editor ${revealed ? "" : "blurred"}`} value={draft} onChange={(e) => editDraft(e.target.value)} spellCheck={false} readOnly={!revealed} tabIndex={revealed ? undefined : -1} />
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
          <button className="btn" disabled={saving || !revealed || draft === baseline.current} onClick={save}>
            {saving ? "Saving..." : "Save"}
          </button>
          {revealed && (
            <button className="btn secondary" disabled={saving || draft === baseline.current} onClick={() => baseline.current !== null && editDraft(baseline.current)}>
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
