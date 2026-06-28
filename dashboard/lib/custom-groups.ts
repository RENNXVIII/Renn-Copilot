// Custom-provider grouping is a dashboard-only concept -- it's never sent to
// CLIProxyAPI's Management API (PUT /openai-compatibility), since there's no
// guarantee the real server preserves unrecognized fields on an entry. Stored
// locally instead, keyed by the openai-compatibility entry's `name` field.
//
// Shared between the Providers page (where the grouping is assigned) and the
// Models page (where it's used to label models that came from a custom
// provider instead of an OAuth login), since both run in the same browser and
// can read the same localStorage key.
const CUSTOM_GROUPS_KEY = "renn-copilot:custom-provider-groups";

export function loadCustomGroups(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(CUSTOM_GROUPS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveCustomGroups(groups: Record<string, string>) {
  window.localStorage.setItem(CUSTOM_GROUPS_KEY, JSON.stringify(groups));
}
