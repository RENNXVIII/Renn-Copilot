import fs from "node:fs";
import path from "node:path";
import { settings, ensureDirs } from "./settings.js";

function statePath() {
  return path.join(settings.cliproxyHome, "renn-copilot-state.json");
}

const defaultState = {
  enabledModelIds: [],
  // Single global switch for whether account emails are shown in full or
  // masked, shared by the dashboard (every row that renders an email) and
  // the VS Code extension's status bar/tooltip -- replaces what used to be
  // a separate reveal/hide toggle on every individual row.
  revealEmails: false,
  // Learned model id -> provider attributions, recorded only while exactly
  // one OAuth provider is logged in (the only time CLIProxyAPI's flat
  // /v1/models list is unambiguous). Consulted before guessProvider()'s
  // name-based fallback so that logging into a second provider later
  // doesn't re-misattribute ids we already know the real answer for.
  // See model-catalog.js for the full rationale.
  modelProviderMemory: {},
  // Verified (not guessed) per-model capability results, keyed by model id.
  // Populated by routes.js's ensureVisionProbed()/the manual verify-vision
  // endpoint, which actually sends a tiny test image through CLIProxyAPI
  // rather than assuming every model supports it -- a real request that
  // costs real tokens/credit against a live account. Each entry looks like
  // { vision: true | false | "unknown", note?: string, checkedAt: number },
  // and once an id has ANY entry here (even an inconclusive "unknown" one)
  // it is never auto-probed again, no matter how long it's been -- only the
  // dashboard's manual "Re-check" action re-probes an already-checked id, as
  // a deliberate user-initiated request rather than an automatic retry.
  modelCapabilities: {},
};

export function readState() {
  ensureDirs();
  if (!fs.existsSync(statePath())) return { ...defaultState };
  try {
    return { ...defaultState, ...JSON.parse(fs.readFileSync(statePath(), "utf8")) };
  } catch {
    return { ...defaultState };
  }
}

export function writeState(partial) {
  const next = { ...readState(), ...partial };
  ensureDirs();
  fs.writeFileSync(statePath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}
