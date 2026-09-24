import type { ModelCapabilityPatch, ModelEntry } from "../api/client";

export const COMMON_REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"];

type TokenField = "inputTokens" | "outputTokens";

export interface CapabilityFormState {
  vision: "auto" | "supported" | "unsupported";
  reasoningMode: "auto" | "enabled" | "disabled";
  reasoningLevels: string[];
  customReasoningLevels: string;
  tokenModes: Record<TokenField, "auto" | "manual">;
  tokenValues: Record<TokenField, string>;
}

export function capabilityFormFromModel(model: ModelEntry): CapabilityFormState {
  const overrides = model.capabilityConfiguration.overrides;
  const overriddenLevels = overrides.reasoningLevels ?? model.capabilityConfiguration.reasoning.levels;
  const commonLevels = overriddenLevels.filter((level) => COMMON_REASONING_LEVELS.includes(level));
  const customLevels = overriddenLevels.filter((level) => !COMMON_REASONING_LEVELS.includes(level));
  return {
    vision: typeof overrides.vision === "boolean" ? (overrides.vision ? "supported" : "unsupported") : "auto",
    reasoningMode:
      typeof overrides.reasoningSupported === "boolean" ? (overrides.reasoningSupported ? "enabled" : "disabled") : "auto",
    reasoningLevels: commonLevels,
    customReasoningLevels: customLevels.join(", "),
    tokenModes: {
      inputTokens: overrides.inputTokens ? "manual" : "auto",
      outputTokens: overrides.outputTokens ? "manual" : "auto",
    },
    tokenValues: {
      inputTokens: String(overrides.inputTokens ?? model.capabilityConfiguration.limits.effective.inputTokens ?? ""),
      outputTokens: String(overrides.outputTokens ?? model.capabilityConfiguration.limits.effective.outputTokens ?? ""),
    },
  };
}

function parseToken(value: string, label: string): number {
  const normalized = value.replace(/,/g, "").trim();
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function normalizedLevels(state: CapabilityFormState): string[] {
  const custom = state.customReasoningLevels
    .split(",")
    .map((level) => level.trim().toLowerCase())
    .filter((level) => level && level !== "auto" && level !== "-1");
  return Array.from(new Set([...state.reasoningLevels, ...custom]));
}

export function capabilityPatchFromForm(state: CapabilityFormState): ModelCapabilityPatch {
  const levels = normalizedLevels(state);
  if (state.reasoningMode === "enabled" && levels.length === 0) {
    throw new Error("Select or enter at least one reasoning effort level.");
  }

  const patch: ModelCapabilityPatch = {
    vision: state.vision === "auto" ? null : state.vision === "supported",
    reasoningSupported: state.reasoningMode === "auto" ? null : state.reasoningMode === "enabled",
    reasoningLevels: state.reasoningMode === "auto" ? null : state.reasoningMode === "enabled" ? levels : null,
    contextTokens: null,
  };
  const labels: Record<TokenField, string> = {
    inputTokens: "Max input tokens",
    outputTokens: "Max output tokens",
  };
  for (const field of Object.keys(state.tokenModes) as TokenField[]) {
    patch[field] = state.tokenModes[field] === "auto" ? null : parseToken(state.tokenValues[field], labels[field]);
  }
  return patch;
}
