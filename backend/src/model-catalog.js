/**
 * Static catalog of models we know CLIProxyAPI can serve via OAuth providers,
 * mapped to the shape VS Code's BYOK setting (github.copilot.chat.customOAIModels)
 * expects. The dashboard lets the user toggle which of these get pushed to the
 * extension; CLIProxyAPI itself decides at request time whether the underlying
 * provider/account actually supports a given model.
 *
 * Source: provider docs at help.router-for.me/configuration/provider/*
 */
export const MODEL_CATALOG = [
  // --- Antigravity (Google OAuth) ---------------------------------------
  { id: "antigravity/claude-sonnet-4.5", provider: "antigravity", family: "claude", label: "Claude Sonnet 4.5 (via Antigravity)", thinking: false },
  { id: "antigravity/claude-sonnet-4.5-thinking", provider: "antigravity", family: "claude", label: "Claude Sonnet 4.5 Thinking (via Antigravity)", thinking: true },
  { id: "antigravity/claude-opus-4.5-thinking", provider: "antigravity", family: "claude", label: "Claude Opus 4.5 Thinking (via Antigravity)", thinking: true },
  { id: "antigravity/gemini-3-pro-preview", provider: "antigravity", family: "gemini", label: "Gemini 3 Pro (Preview, via Antigravity)", thinking: false },
  { id: "antigravity/gemini-3-flash-preview", provider: "antigravity", family: "gemini", label: "Gemini 3 Flash (Preview, via Antigravity)", thinking: false },
  { id: "antigravity/gemini-2.5-flash", provider: "antigravity", family: "gemini", label: "Gemini 2.5 Flash (via Antigravity)", thinking: false },

  // --- Claude Code (Anthropic OAuth / Claude web) -----------------------
  { id: "claude/claude-sonnet-4.5", provider: "claude", family: "claude", label: "Claude Sonnet 4.5 (Claude Code login)", thinking: false },
  { id: "claude/claude-opus-4.5", provider: "claude", family: "claude", label: "Claude Opus 4.5 (Claude Code login)", thinking: false },

  // --- Codex (ChatGPT OAuth) ---------------------------------------------
  { id: "codex/gpt-5.1", provider: "codex", family: "gpt", label: "GPT-5.1 (Codex login)", thinking: false },
];

/**
 * CLIProxyAPI's /v1/models doesn't namespace ids by login provider -- it
 * returns the raw underlying model id (e.g. "claude-opus-4-1-20250805",
 * "gemini-3.1-flash-image"), not "claude/claude-opus-4-1-20250805". So for
 * ids we don't already know about, we can't read the provider off a path
 * segment.
 *
 * If exactly one OAuth provider actually has stored credentials, there's no
 * ambiguity -- every live id necessarily came from that one account, since
 * CLIProxyAPI only ever returns models for accounts that are logged in.
 * (This matters because Antigravity alone serves Gemini- *and* Claude- *and*
 * GPT-named ids through a single Google OAuth login -- guessing "claude" in
 * the name means "Claude Code login" would wrongly invent a separate
 * "Claude"/"Codex" provider group with no credential behind it.)
 *
 * Only when 0 or 2+ providers are logged in (genuinely ambiguous) do we fall
 * back to guessing from the model name, same buckets as the Providers page.
 *
 * CLIProxyAPI itself gives us no better signal here: its /v1/models response
 * is a flat, unattributed list (confirmed against its source -- the registry
 * keeps one entry per model id with no per-OAuth-account tag, and the
 * `owned_by` field it does expose reflects the underlying model vendor, e.g.
 * "anthropic", not which logged-in account is actually serving it). So once
 * 2+ providers are logged in, there's no live API call that can tell us
 * "this claude-named id is really coming through Antigravity" -- the only
 * place that fact can live is in something *we* remember from before it
 * became ambiguous. See resolveProvider() below for how that's used.
 */
function guessProvider(id, loggedInProviders = []) {
  if (loggedInProviders.length === 1) return loggedInProviders[0];

  const lower = id.toLowerCase();
  if (lower.includes("gemini")) return "antigravity"; // Gemini is Antigravity-only today
  if (lower.includes("claude")) return "claude";
  if (lower.includes("gpt") || lower.includes("codex") || /\bo[134]\b/.test(lower)) return "codex";
  return "other";
}

/**
 * Resolves a live model id to a provider, preferring (in order):
 *  1. The unambiguous single-provider shortcut.
 *  2. A previously-learned attribution (`memory[id]`), recorded the last
 *     time this id was seen under shortcut #1 -- this is what keeps
 *     Antigravity-served Claude/GPT-named ids pinned to "antigravity" even
 *     after a second provider (e.g. Codex) logs in and re-introduces
 *     ambiguity.
 *  3. The name-based guess, only for ids we've never seen unambiguously.
 */
function resolveProvider(id, loggedInProviders, memory) {
  if (loggedInProviders.length === 1) return loggedInProviders[0];
  if (memory[id]) return memory[id];
  return guessProvider(id, loggedInProviders);
}

/**
 * Builds a model-id -> custom-provider-name lookup from CLIProxyAPI's
 * openai-compatibility entries, so ids served by a custom (non-OAuth)
 * provider get bucketed under that provider's own name instead of being
 * swept into whichever OAuth provider happens to be logged in.
 *
 * Each entry should declare its `models` array (the dashboard's "Model IDs"
 * field), but older/hand-edited entries may not -- if `models` is empty, we
 * fall back to treating the entry's own `name` as the one model id it
 * serves (covers the case where someone typed the model id itself into the
 * "Name" field, which CLIProxyAPI will accept either way).
 */
function buildCustomProviderIndex(openAiCompatEntries = []) {
  const index = new Map();
  for (const entry of openAiCompatEntries) {
    if (!entry?.name) continue;
    const modelIds = Array.isArray(entry.models) && entry.models.length
      ? entry.models.map((m) => m?.name).filter(Boolean)
      : [entry.name];
    for (const id of modelIds) index.set(id, entry.name);
  }
  return index;
}

/**
 * Merges CLIProxyAPI's live /v1/models ids with our static catalog: ids we
 * already know about keep their nice label/family/thinking flag, ids we've
 * never seen (new models CLIProxyAPI added that we haven't hand-typed yet)
 * still show up, bucketed into a provider via guessProvider() and labeled
 * from the id itself.
 *
 * Returns an empty list when there are no live ids (CLIProxyAPI not running,
 * or no accounts logged in yet) -- we deliberately don't fall back to
 * showing the static catalog as if it were real, since that list mixes
 * models the current accounts may not actually have access to and confuses
 * "what's toggleable" with "what CLIProxyAPI can actually serve right now".
 *
 * `loggedInProviders` is the list of provider ids that actually have at
 * least one stored auth file (from GET /auth-files) -- passed in so unknown
 * ids get bucketed by real stored credentials instead of just guessed names.
 *
 * `openAiCompatEntries` is the raw list from GET /openai-compatibility --
 * ids that match one of these are bucketed under that entry's own name
 * *before* guessProvider/loggedInProviders ever run, so a custom provider
 * never gets misattributed to whichever single OAuth provider is logged in
 * (see buildCustomProviderIndex).
 *
 * `memory` is the persisted id -> provider map learned during past
 * unambiguous (single-provider) calls (see resolveProvider doc above).
 * Returns the updated memory alongside the model list -- the caller
 * (routes.js) is responsible for persisting it via state.js so the learned
 * attribution survives across requests and server restarts.
 */
export function buildModelList(liveIds = [], loggedInProviders = [], openAiCompatEntries = [], memory = {}) {
  if (!liveIds.length) return { models: [], memory };

  const byId = new Map(MODEL_CATALOG.map((m) => [m.id, m]));
  const customProviderById = buildCustomProviderIndex(openAiCompatEntries);
  const nextMemory = { ...memory };

  const models = liveIds.map((id) => {
    const customProvider = customProviderById.get(id);
    if (customProvider) {
      return {
        id,
        provider: customProvider,
        family: customProvider,
        label: `${id} (via ${customProvider})`,
        thinking: /thinking/i.test(id),
      };
    }

    const known = byId.get(id);
    if (known) return known;

    const provider = resolveProvider(id, loggedInProviders, memory);
    if (loggedInProviders.length === 1) nextMemory[id] = provider;
    return {
      id,
      provider,
      family: provider,
      label: `${id} (new, via ${provider})`,
      thinking: /thinking/i.test(id),
    };
  });

  return { models, memory: nextMemory };
}

/** Builds the entry shape expected by github.copilot.chat.customOAIModels. */
export function toCopilotModelEntry(model, { proxyUrl }) {
  return {
    id: model.id,
    name: model.label,
    url: `${proxyUrl}/v1/chat/completions`,
    toolCalling: true,
    vision: false,
    maxInputTokens: model.thinking ? 32000 : 128000,
    maxOutputTokens: model.thinking ? 2048 : 4096,
  };
}
