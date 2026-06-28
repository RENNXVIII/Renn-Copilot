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
