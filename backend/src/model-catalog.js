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
  { id: "antigravity/claude-sonnet-4.5", provider: "antigravity", family: "claude", label: "Claude Sonnet 4.5 (via Antigravity)", thinking: false, vision: true },
  { id: "antigravity/claude-sonnet-4.5-thinking", provider: "antigravity", family: "claude", label: "Claude Sonnet 4.5 Thinking (via Antigravity)", thinking: true, vision: true },
  { id: "antigravity/claude-opus-4.5-thinking", provider: "antigravity", family: "claude", label: "Claude Opus 4.5 Thinking (via Antigravity)", thinking: true, vision: true },
  { id: "antigravity/gemini-3-pro-preview", provider: "antigravity", family: "gemini", label: "Gemini 3 Pro (Preview, via Antigravity)", thinking: false, vision: true },
  { id: "antigravity/gemini-3-flash-preview", provider: "antigravity", family: "gemini", label: "Gemini 3 Flash (Preview, via Antigravity)", thinking: false, vision: true },
  { id: "antigravity/gemini-2.5-flash", provider: "antigravity", family: "gemini", label: "Gemini 2.5 Flash (via Antigravity)", thinking: false, vision: true },

  // --- Claude Code (Anthropic OAuth / Claude web) -----------------------
  { id: "claude/claude-sonnet-4.5", provider: "claude", family: "claude", label: "Claude Sonnet 4.5 (Claude Code login)", thinking: false, vision: true },
  { id: "claude/claude-opus-4.5", provider: "claude", family: "claude", label: "Claude Opus 4.5 (Claude Code login)", thinking: false, vision: true },

  // --- Codex (ChatGPT OAuth) ---------------------------------------------
  { id: "codex/gpt-5.1", provider: "codex", family: "gpt", label: "GPT-5.1 (Codex login)", thinking: false, vision: true },
];

export function modelCapabilityKey(model) {
  return `${model.provider}::${model.id}`;
}

export function resolveVisionCapability(model, storedCapability) {
  if (typeof storedCapability?.override === "boolean") {
    return {
      vision: storedCapability.override,
      source: "manual",
      checkedAt: storedCapability.overrideAt,
    };
  }
  if (storedCapability?.probe) {
    return storedCapability.probe;
  }
  if (storedCapability?.source === "manual" && typeof storedCapability.vision === "boolean") {
    return storedCapability;
  }
  if (storedCapability && (typeof storedCapability.vision === "boolean" || storedCapability.vision === "unknown")) {
    return storedCapability;
  }
  if (typeof model.vision === "boolean") {
    return { vision: model.vision, source: "catalog" };
  }
  return { vision: "unknown", source: "unknown" };
}

export function migrateLegacyVisionCapability(legacy) {
  if (!legacy || typeof legacy !== "object") return undefined;
  if (typeof legacy.override === "boolean" || legacy.probe) return legacy;
  if (legacy.source === "manual" && typeof legacy.vision === "boolean") {
    return { override: legacy.vision, overrideAt: legacy.checkedAt };
  }
  return {
    probe: {
      ...legacy,
      source: legacy.source || "probe",
    },
  };
}

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
  const guess = lower.includes("gemini")
    ? "antigravity" // Gemini is Antigravity-only today
    : lower.includes("claude")
      ? "claude"
      : lower.includes("grok")
        ? "xai"
        : lower.includes("gpt") || lower.includes("codex") || /\bo[134]\b/.test(lower)
          ? "codex"
          : "other";

  // Only trust the name-based guess if that provider is actually logged in
  // right now -- otherwise (e.g. a claude-named id naively guessed as
  // "claude" when only antigravity+codex are logged in, because the real
  // Claude Code login was never completed or was removed) this would invent
  // a phantom provider group with zero credentials behind it. "other" is an
  // honest "couldn't attribute this" bucket instead of a confidently wrong one.
  return loggedInProviders.includes(guess) ? guess : "other";
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
  // Only trust a learned attribution if that provider is *still* logged in --
  // otherwise a model we once saw under (say) antigravity would keep showing
  // under a phantom "antigravity" group after that provider is logged out,
  // even though it's now actually served by whichever provider remains.
  if (memory[id] && loggedInProviders.includes(memory[id])) return memory[id];
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
 *
 * `prefixIndex` maps a credential's `prefix` (see routes.js's
 * /auth-files/prefix, management-client.js's setAuthFilePrefix) to its real
 * provider. A live id like "claude/claude-sonnet-4-6" -- CLIProxyAPI's own
 * namespacing for a prefixed credential, giving it a routable id no other
 * credential shares -- resolves straight to that credential's actual
 * provider here, with total certainty (no guessing needed): this is exactly
 * the mechanism that lets two credentials serving the identical bare model
 * id (e.g. Antigravity and Claude Code both offering "claude-sonnet-4-6")
 * be told apart and toggled independently in the Models page.
 */
export function buildModelList(liveIds = [], loggedInProviders = [], openAiCompatEntries = [], memory = {}, prefixIndex = {}) {
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

    const slash = id.indexOf("/");
    if (slash > 0) {
      const prefix = id.slice(0, slash);
      const owner = prefixIndex[prefix];
      if (owner) {
        const rest = id.slice(slash + 1);
        return {
          id,
          provider: owner,
          family: owner,
          label: `${rest} (${prefix}, via ${owner})`,
          thinking: /thinking/i.test(id),
        };
      }
    }

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

/**
 * Keeps explicitly enabled models exportable even when CLIProxyAPI's live
 * model list is temporarily incomplete (for example during startup or while
 * an account is reconnecting). The live catalog remains authoritative for
 * metadata; an enabled id missing from it gets a conservative fallback entry
 * instead of disappearing from VS Code's provider group.
 */
export function mergeEnabledModels(catalog = [], enabledModelIds = [], providerMemory = {}) {
  const modelsById = new Map(catalog.map((model) => [model.id, model]));
  const models = [];

  for (const id of enabledModelIds) {
    const known = modelsById.get(id);
    if (known) {
      models.push(known);
      continue;
    }

    const provider = providerMemory[id] || "other";
    models.push({
      id,
      provider,
      family: provider,
      label: id,
      thinking: /thinking/i.test(id),
    });
  }

  return models;
}

/**
 * Builds the entry shape expected by VS Code's Custom Endpoint chat model
 * provider (written verbatim into chatLanguageModels.json by the extension).
 *
 * `vision` used to be hardcoded `false` for every model, which is why image
 * attachments never worked for any Renn Copilot model in Copilot Chat --
 * VS Code reads this flag to decide whether it's even allowed to send image
 * content to a model, regardless of what the underlying model can actually
 * do.
 *
 * It's driven by the resolved capability assembled in routes.js. Unknown is
 * deliberately exported as false: VS Code should only offer image attachment
 * UI after a curated catalog entry, successful probe, or manual override has
 * positively established support.
 */
export function toCopilotModelEntry(model, { proxyUrl, ownBaseUrl }) {
  const verifiedVision = model.capabilities?.vision;
  // Claude-family models (any provider -- Antigravity, Claude Code login, or
  // a custom endpoint) get routed through our own sanitizing proxy instead
  // of straight to CLIProxyAPI, since Anthropic rejects non-default
  // top_p/temperature/top_k on Claude Opus 4.7+/Sonnet 4.5+ and CLIProxyAPI
  // forwards them unmodified (see chat-proxy.js). Everything else is
  // unaffected and keeps going directly to CLIProxyAPI.
  const isClaude = /claude/i.test(model.id);
  const url = isClaude && ownBaseUrl ? `${ownBaseUrl}/api/proxy/v1/chat/completions` : `${proxyUrl}/v1/chat/completions`;
  return {
    id: model.id,
    name: model.label,
    url,
    toolCalling: true,
    vision: verifiedVision === true,
    maxInputTokens: model.thinking ? 32000 : 128000,
    maxOutputTokens: model.thinking ? 2048 : 4096,
  };
}
