const TOKEN_FIELDS = ["contextTokens", "inputTokens", "outputTokens"];
const OVERRIDE_FIELDS = new Set(["vision", "reasoningSupported", "reasoningLevels", ...TOKEN_FIELDS]);

function positiveInteger(value, field) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${field} must be a positive integer or null.`);
    }
    return value;
}

function firstPositiveInteger(...values) {
    for (const value of values) {
        if (Number.isSafeInteger(value) && value > 0) return value;
    }
    return undefined;
}

function normalizeLevels(values) {
    if (!Array.isArray(values)) throw new Error("reasoningLevels must be an array of strings or null.");
    const levels = Array.from(new Set(values.map((value) => {
        if (typeof value !== "string") throw new Error("reasoningLevels must contain only strings.");
        return value.trim().toLowerCase();
    }).filter((value) => value && value !== "auto" && value !== "-1")));
    return levels;
}

export function normalizeDetectedTokenLimits(raw) {
    if (!raw || typeof raw !== "object") return {};
    const contextTokens = firstPositiveInteger(raw.context_length, raw.contextLength, raw.context_tokens, raw.contextTokens);
    const inputTokens = firstPositiveInteger(raw.max_input_tokens, raw.maxInputTokens, raw.input_tokens, raw.inputTokens);
    const outputTokens = firstPositiveInteger(raw.max_output_tokens, raw.maxOutputTokens, raw.output_tokens, raw.outputTokens);
    return {
        ...(contextTokens ? { contextTokens } : {}),
        ...(inputTokens ? { inputTokens } : {}),
        ...(outputTokens ? { outputTokens } : {}),
    };
}

export function resolveCapabilityConfiguration(detectedReasoning, detectedLimits = {}, overrides = {}) {
    const reasoningManuallyConfigured = typeof overrides.reasoningSupported === "boolean" || Array.isArray(overrides.reasoningLevels);
    const detectedSupported = detectedReasoning?.supported === true;
    const supported = typeof overrides.reasoningSupported === "boolean" ? overrides.reasoningSupported : detectedSupported;
    const levels = supported
        ? Array.isArray(overrides.reasoningLevels)
            ? overrides.reasoningLevels
            : detectedSupported
                ? detectedReasoning.levels || []
                : []
        : [];

    const effective = {};
    const sources = {};
    for (const field of TOKEN_FIELDS) {
        if (Number.isSafeInteger(overrides[field]) && overrides[field] > 0) {
            effective[field] = overrides[field];
            sources[field] = "manual";
        } else if (Number.isSafeInteger(detectedLimits[field]) && detectedLimits[field] > 0) {
            effective[field] = detectedLimits[field];
            sources[field] = "detected";
        }
    }

    return {
        reasoning: {
            supported,
            levels,
            source: reasoningManuallyConfigured ? "manual" : detectedReasoning?.source || "unknown",
            ...(detectedReasoning?.defaultLevel && levels.includes(detectedReasoning.defaultLevel)
                ? { defaultLevel: detectedReasoning.defaultLevel }
                : {}),
            ...(typeof detectedReasoning?.dynamicAllowed === "boolean"
                ? { dynamicAllowed: detectedReasoning.dynamicAllowed }
                : {}),
            ...(typeof detectedReasoning?.zeroAllowed === "boolean"
                ? { zeroAllowed: detectedReasoning.zeroAllowed }
                : {}),
            ...(detectedReasoning?.checkedAt ? { checkedAt: detectedReasoning.checkedAt } : {}),
        },
        limits: {
            detected: { ...detectedLimits },
            effective,
            overrides: Object.fromEntries(TOKEN_FIELDS.filter((field) => overrides[field] !== undefined).map((field) => [field, overrides[field]])),
            sources,
        },
    };
}

function validateEffectiveConfiguration(detectedReasoning, detectedLimits, overrides, explicitFields = new Set()) {
    const resolved = resolveCapabilityConfiguration(detectedReasoning, detectedLimits, overrides);
    if (resolved.reasoning.supported && resolved.reasoning.levels.length === 0) {
        throw new Error("Reasoning requires at least one reasoning level.");
    }
    if (explicitFields.has("reasoningLevels") && overrides.reasoningSupported !== false && overrides.reasoningLevels?.length === 0) {
        throw new Error("Reasoning requires at least one reasoning level.");
    }

    const { contextTokens, inputTokens, outputTokens } = resolved.limits.effective;
    if (contextTokens && inputTokens && inputTokens > contextTokens) {
        throw new Error("inputTokens must not exceed contextTokens.");
    }
    if (contextTokens && outputTokens && outputTokens > contextTokens) {
        throw new Error("outputTokens must not exceed contextTokens.");
    }
    if (contextTokens && inputTokens && outputTokens && inputTokens + outputTokens > contextTokens) {
        throw new Error("inputTokens and outputTokens sum must not exceed contextTokens.");
    }
}

export function applyCapabilityOverrides(current = {}, patch = {}, detectedReasoning = null, detectedLimits = {}) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Capability patch must be an object.");
    for (const field of Object.keys(patch)) {
        if (!OVERRIDE_FIELDS.has(field)) throw new Error(`Unknown capability field "${field}".`);
    }

    const next = { ...current };
    for (const [field, value] of Object.entries(patch)) {
        if (value === null) {
            delete next[field];
            continue;
        }
        if (field === "vision" || field === "reasoningSupported") {
            if (typeof value !== "boolean") throw new Error(`${field} must be boolean or null.`);
            next[field] = value;
            continue;
        }
        if (field === "reasoningLevels") {
            next[field] = normalizeLevels(value);
            continue;
        }
        next[field] = positiveInteger(value, field);
    }

    if (next.reasoningSupported === false) delete next.reasoningLevels;
    validateEffectiveConfiguration(detectedReasoning, detectedLimits, next, new Set(Object.keys(patch)));
    return next;
}
