// Pure (I/O-free, vscode-free) logic for maintaining the single
// chatLanguageModels.json provider entry this extension owns. Kept separate
// from extension.ts so it can be unit-tested under plain `node --test` without
// the @vscode/test-electron harness (extension.ts imports `vscode`, which
// isn't available there). extension.ts does the actual file read/write and
// calls into these.

export const PROVIDER_NAME = "Renn Copilot";
export const PROVIDER_VENDOR = "customendpoint";
export const API_TYPE = "chat-completions"; // CLIProxyAPI exposes an OpenAI-compatible /v1/chat/completions surface

export interface RemoteModelEntry {
  id: string;
  name: string;
  url: string;
  toolCalling?: boolean;
  vision?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface ChatLanguageModelProvider {
  name: string;
  vendor: string;
  apiKey?: string;
  apiType?: string;
  models?: RemoteModelEntry[];
  [key: string]: unknown;
}

/** True for the one provider entry this extension owns. */
function isOwnEntry(p: ChatLanguageModelProvider): boolean {
  return p.vendor === PROVIDER_VENDOR && p.name === PROVIDER_NAME;
}

/**
 * Given the providers currently on disk, returns the array with our entry
 * inserted or updated, plus flags describing what happened. `changed` is false
 * when our entry was already byte-identical -- the caller uses that to skip
 * rewriting the file (see extension.ts writeProviderEntry's comment about not
 * touching mtime, which resets VS Code's manually-entered API-key secret).
 *
 * Does not mutate the input array.
 */
export function upsertProviderEntry(
  providers: ChatLanguageModelProvider[],
  models: RemoteModelEntry[],
  apiKey: string
): { providers: ChatLanguageModelProvider[]; created: boolean; changed: boolean } {
  const existingIndex = providers.findIndex(isOwnEntry);
  const entry: ChatLanguageModelProvider = {
    name: PROVIDER_NAME,
    vendor: PROVIDER_VENDOR,
    // Omit the field entirely rather than writing an empty string -- an
    // empty "apiKey": "" line is misleading when rennCopilot.requireApiKey
    // is off (the backend isn't expecting one at all in that mode).
    ...(apiKey ? { apiKey } : {}),
    apiType: API_TYPE,
    models,
  };

  const created = existingIndex === -1;
  const existingEntry = created ? null : providers[existingIndex];
  const unchanged = !created && JSON.stringify(existingEntry) === JSON.stringify(entry);
  if (unchanged) {
    return { providers, created: false, changed: false };
  }

  const next = providers.slice();
  if (created) {
    next.push(entry);
  } else {
    next[existingIndex] = entry;
  }
  return { providers: next, created, changed: true };
}

/**
 * Given the providers currently on disk, returns the array with our entry
 * removed (leaving any others untouched) and whether anything was removed.
 * Does not mutate the input array.
 */
export function stripProviderEntry(providers: ChatLanguageModelProvider[]): {
  providers: ChatLanguageModelProvider[];
  removed: boolean;
} {
  const index = providers.findIndex(isOwnEntry);
  if (index === -1) return { providers, removed: false };
  const next = providers.slice();
  next.splice(index, 1);
  return { providers: next, removed: true };
}

/**
 * Masks the local part of an email so the full address doesn't show up in the
 * status bar tooltip / quick pick (mirrors dashboard/lib/utils.ts's maskEmail).
 * Non-email strings pass through unchanged.
 */
export function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(3, local.length - visible.length))}${domain}`;
}
