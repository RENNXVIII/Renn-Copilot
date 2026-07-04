// Ported from dashboard/lib/custom-groups.ts -- dashboard-only concept, never
// sent to CLIProxyAPI's Management API, stored locally keyed by the
// openai-compatibility entry's `name` field.
const CUSTOM_GROUPS_KEY = "renn-copilot:custom-provider-groups";

export function loadCustomGroups(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(CUSTOM_GROUPS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveCustomGroups(groups: Record<string, string>) {
  window.localStorage.setItem(CUSTOM_GROUPS_KEY, JSON.stringify(groups));
}
