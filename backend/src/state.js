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
  // When true, Claude chat requests leave renn's chat-proxy hop with a
  // Cowork-style client fingerprint (User-Agent entrypoint + workload header)
  // so CLIProxyAPI's Claude OAuth cloaking embeds cc_entrypoint=cowork /
  // cc_workload=cowork. Off by default -- enabling is at the user's own risk
  // (TOS / billing / account classification). See chat-proxy.js.
  claudeCoworkMode: false,
  // Learned model id -> provider attributions, recorded only while exactly
  // one OAuth provider is logged in (the only time CLIProxyAPI's flat
  // /v1/models list is unambiguous). Consulted before guessProvider()'s
  // name-based fallback so that logging into a second provider later
  // doesn't re-misattribute ids we already know the real answer for.
  // See model-catalog.js for the full rationale.
  modelProviderMemory: {},
  // Per-model capability evidence, keyed by "<provider>::<model-id>" so two
  // providers exposing the same id never share a result. Entries include a
  // source ("probe" or "manual"), checkedAt, and optional note. Curated
  // catalog evidence is resolved at runtime and is not copied into state.
  // Legacy model-id-only keys are migrated lazily when that model is listed.
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
  const target = statePath();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return next;
}
