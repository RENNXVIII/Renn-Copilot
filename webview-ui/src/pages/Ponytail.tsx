import { useEffect, useState } from "react";
import { postOpenExternal, requestPonytail, type PonytailMode, type PonytailResponse, type PonytailStatus } from "../vscodeApi";

const MODES: { id: PonytailMode; label: string; description: string }[] = [
  { id: "lite", label: "Lite", description: "Builds what you ask, and names a simpler alternative in one line." },
  { id: "full", label: "Full", description: "Enforces the simplest-first ladder: standard library and native features, smallest diff. Recommended." },
  { id: "ultra", label: "Ultra", description: "Prefers deleting code and challenges speculative requirements. Explicit requests still win." },
];

export function Ponytail() {
  const [status, setStatus] = useState<PonytailStatus | null>(null);
  const [activeMode, setActiveMode] = useState<PonytailMode | null>(null);
  const [selected, setSelected] = useState<PonytailMode>("full");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function apply(response: PonytailResponse) {
    if (response.status) setStatus(response.status);
    setActiveMode(response.status === "enabled" ? response.mode ?? null : null);
    if (response.mode) setSelected(response.mode);
    if (response.error) setError(response.error);
  }

  useEffect(() => {
    let active = true;
    void requestPonytail("status").then((response) => {
      if (active) apply(response);
    });
    return () => { active = false; };
  }, []);

  async function act(action: "enable" | "disable", mode?: PonytailMode) {
    setBusy(true);
    setError(null);
    try {
      apply(await requestPonytail(action, mode));
    } finally {
      setBusy(false);
    }
  }

  // Once enabled, picking a mode applies it immediately; before that, it just
  // chooses what "Enable" will write.
  function pickMode(mode: PonytailMode) {
    setSelected(mode);
    if (status === "enabled" && mode !== activeMode) void act("enable", mode);
  }

  const statusText = error
    ? `Error: ${error}`
    : status === "enabled"
      ? `Enabled · ${activeMode ?? "full"} mode`
      : status === "disabled"
        ? "Disabled"
        : status === "conflict"
          ? "Instruction file modified; manage it manually."
          : "Checking status…";

  return (
    <div className="page">
      <div>
        <h1>Ponytail</h1>
        <p className="page-hint">Smaller, correct changes for GitHub Copilot Chat, inspired by <button className="ponytail-link" onClick={() => postOpenExternal("https://github.com/DietrichGebert/ponytail")}>Ponytail</button>.</p>
      </div>
      <div className="card">
        <div className="card-title">Workspace instructions</div>
        <p className="card-desc">Adds a separate <code>.github/instructions/renn-ponytail.instructions.md</code> file. Existing Copilot instructions remain untouched. Applies to new Copilot Chat requests in this workspace; it does not install the Copilot CLI plugin or change CLI session modes.</p>
        <div role="status">{statusText}</div>
        <div className="field">
          <span className="field-label" id="ponytail-mode-label">Mode</span>
          <div className="rtk-seg" role="radiogroup" aria-labelledby="ponytail-mode-label">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={selected === m.id}
                className={selected === m.id ? "active" : ""}
                disabled={busy || status === "conflict" || status === null}
                onClick={() => pickMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <span className="card-desc">{MODES.find((m) => m.id === selected)?.description}</span>
        </div>
        <div className="btn-row">
          <button className="btn" disabled={busy || status !== "disabled"} onClick={() => void act("enable", selected)}>Enable in workspace</button>
          <button className="btn secondary" disabled={busy || status !== "enabled"} onClick={() => void act("disable")}>Disable</button>
        </div>
      </div>
    </div>
  );
}