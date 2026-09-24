import test from "node:test";
import assert from "node:assert/strict";
import { capabilityFormFromModel, capabilityPatchFromForm, type CapabilityFormState } from "./capability-form";
import type { ModelEntry } from "../api/client";

const model: ModelEntry = {
  id: "gpt-test",
  provider: "codex",
  family: "gpt",
  label: "GPT Test",
  thinking: true,
  enabled: true,
  capabilities: { vision: true, source: "catalog" },
  reasoning: {
    supported: true,
    levels: ["low", "medium", "high"],
    selectedLevel: null,
    source: "model-definitions",
  },
  capabilityConfiguration: {
    overrides: {},
    reasoning: {
      supported: true,
      levels: ["low", "medium", "high"],
      source: "model-definitions",
    },
    limits: {
      detected: { contextTokens: 128000, inputTokens: 120000, outputTokens: 8000 },
      effective: { contextTokens: 128000, inputTokens: 120000, outputTokens: 8000 },
      overrides: {},
      sources: { contextTokens: "detected", inputTokens: "detected", outputTokens: "detected" },
    },
  },
};

test("form initializes capability fields in Auto mode", () => {
  const form = capabilityFormFromModel(model);
  assert.equal(form.vision, "auto");
  assert.equal(form.reasoningMode, "auto");
  assert.deepEqual(form.tokenModes, {
    inputTokens: "auto",
    outputTokens: "auto",
  });
});

test("Auto fields produce null overrides", () => {
  const patch = capabilityPatchFromForm(capabilityFormFromModel(model));
  assert.deepEqual(patch, {
    vision: null,
    reasoningSupported: null,
    reasoningLevels: null,
    contextTokens: null,
    inputTokens: null,
    outputTokens: null,
  });
});

test("manual reasoning and token values are normalized", () => {
  const form: CapabilityFormState = {
    ...capabilityFormFromModel(model),
    vision: "unsupported",
    reasoningMode: "enabled",
    reasoningLevels: ["high", "max"],
    customReasoningLevels: " Ultra, HIGH ",
    tokenModes: { inputTokens: "manual", outputTokens: "manual" },
    tokenValues: { inputTokens: "240000", outputTokens: "16000" },
  };

  assert.deepEqual(capabilityPatchFromForm(form), {
    vision: false,
    reasoningSupported: true,
    reasoningLevels: ["high", "max", "ultra"],
    contextTokens: null,
    inputTokens: 240000,
    outputTokens: 16000,
  });
});

test("manual token fields require positive integers", () => {
  const form = capabilityFormFromModel(model);
  form.tokenModes.outputTokens = "manual";
  form.tokenValues.outputTokens = "-1";
  assert.throws(() => capabilityPatchFromForm(form), /positive integer/);
});
