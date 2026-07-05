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
  // rather than assuming every model supports it. A resolved entry looks
  // like { vision: true | false, note?: string, checkedAt: number } and is
  // never auto-probed again. An inconclusive attempt (quota/rate-limit/auth/
  // transient error) looks like { vision: "unknown", note?: string,
  // lastAttemptAt: number } and is only eligible for another automatic probe
  // once PROBE_RETRY_COOLDOWN_MS has elapsed -- otherwise every /models poll
  // (every ~15s from the dashboard) would keep firing real requests against
  // a still-rate-limited account indefinitely. The dashboard's manual
  // "Re-check" action bypasses the cooldown for an on-demand retry.
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
