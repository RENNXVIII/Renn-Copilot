import test from "node:test";
import assert from "node:assert/strict";
import {
  buildModelList,
  mergeEnabledModels,
  migrateLegacyVisionCapability,
  modelCapabilityKey,
  normalizeReasoningCapability,
  resolveReasoningPreference,
  resolveVisionCapability,
  toCopilotModelEntry,
} from "../src/model-catalog.js";
import { classifyVisionProbeResponse } from "../src/proxy-client.js";

const model = {
  id: "shared-model",
  provider: "custom-a",
  label: "Shared model",
  thinking: false,
};

test("capability keys scope identical model ids by provider", () => {
  assert.notEqual(
    modelCapabilityKey({ provider: "custom-a", id: "shared-model" }),
    modelCapabilityKey({ provider: "custom-b", id: "shared-model" })
  );
  assert.notEqual(
    modelCapabilityKey({ provider: "custom-a", id: "credential-1/shared-model" }),
    modelCapabilityKey({ provider: "custom-a", id: "credential-2/shared-model" })
  );
});

test("manual evidence wins over curated metadata", () => {
  assert.deepEqual(
    resolveVisionCapability({ ...model, vision: true }, { override: false, overrideAt: 1 }),
    { vision: false, source: "manual", checkedAt: 1 }
  );
});

test("resetting a manual override can reveal preserved probe evidence", () => {
  const stored = {
    override: false,
    overrideAt: 2,
    probe: { vision: true, source: "probe", checkedAt: 1 },
  };
  assert.equal(resolveVisionCapability(model, stored).vision, false);
  delete stored.override;
  delete stored.overrideAt;
  assert.deepEqual(resolveVisionCapability(model, stored), { vision: true, source: "probe", checkedAt: 1 });
});

test("catalog evidence fills an otherwise unknown capability", () => {
  assert.deepEqual(resolveVisionCapability({ ...model, vision: true }), { vision: true, source: "catalog" });
  assert.deepEqual(resolveVisionCapability(model), { vision: "unknown", source: "unknown" });
});

test("unknown capability exports vision false", () => {
  const entry = toCopilotModelEntry(
    { ...model, capabilities: { vision: "unknown", source: "unknown" } },
    { proxyUrl: "http://127.0.0.1:8317" }
  );
  assert.equal(entry.vision, false);
});

test("probe requires a response identifying the red image", () => {
  assert.deepEqual(
    classifyVisionProbeResponse({
      ok: true,
      status: 200,
      data: { choices: [{ message: { content: "red" } }] },
    }),
    { vision: true, source: "probe" }
  );

  const ignored = classifyVisionProbeResponse({
    ok: true,
    status: 200,
    data: { choices: [{ message: { content: "I cannot inspect images." } }] },
  });
  assert.equal(ignored.vision, "unknown");
});

test("explicit modality rejection is false but quota errors stay unknown", () => {
  const unsupported = classifyVisionProbeResponse({
    ok: false,
    status: 400,
    data: { error: { message: "image_url content is unsupported for this model" } },
  });
  assert.equal(unsupported.vision, false);

  const quota = classifyVisionProbeResponse({
    ok: false,
    status: 429,
    data: { error: { message: "image quota exceeded" } },
  });
  assert.equal(quota.vision, "unknown");
});

test("image too small errors stay unknown rather than no vision", () => {
  const result = classifyVisionProbeResponse({
    ok: false,
    status: 400,
    data: {
      error: {
        message: "Image dimensions 1x1 are too small. Both width and height must be at least 8 pixels.",
      },
    },
  });
  assert.equal(result.vision, "unknown");
});

test("legacy manual evidence migrates as a removable override", () => {
  assert.deepEqual(
    migrateLegacyVisionCapability({ vision: false, source: "manual", checkedAt: 7 }),
    { override: false, overrideAt: 7 }
  );
});

test("exact custom model ids win over matching credential prefixes", () => {
  const { models } = buildModelList(
    ["meta-llama/llama-3.1"],
    ["claude"],
    [{ name: "custom-router", models: [{ name: "meta-llama/llama-3.1" }] }],
    {},
    { "meta-llama": "claude" }
  );
  assert.equal(models[0].provider, "custom-router");
});

test("credential prefix ownership wins over a colliding static catalog id", () => {
  const { models } = buildModelList(
    ["claude/claude-sonnet-4.5"],
    ["antigravity", "claude"],
    [],
    {},
    { claude: "antigravity" }
  );
  assert.equal(models[0].provider, "antigravity");
  assert.match(models[0].label, /via antigravity/);
});

test("enabled models remain exportable when the live catalog is incomplete", () => {
  const models = mergeEnabledModels(
    [{ id: "live-model", provider: "codex", label: "Live model", thinking: false }],
    ["live-model", "grok-4.5", "xai/grok-4.20"],
    { "grok-4.5": "xai", "xai/grok-4.20": "xai" }
  );

  assert.deepEqual(models.map((item) => item.id), ["live-model", "grok-4.5", "xai/grok-4.20"]);
  assert.equal(models[1].label, "grok-4.5");
  assert.equal(models[1].provider, "xai");
  assert.equal(models[2].provider, "xai");
});

test("reasoning levels are normalized without inventing Auto", () => {
  const capability = normalizeReasoningCapability({
    levels: [" Low ", "medium", "LOW", "auto", "-1", "none", "ultra"],
    zero_allowed: true,
    dynamic_allowed: true,
  });

  assert.deepEqual(capability.levels, ["low", "medium", "none", "ultra"]);
  assert.equal(capability.zeroAllowed, true);
  assert.equal(capability.dynamicAllowed, true);
});

test("budget-only reasoning metadata does not advertise named levels", () => {
  assert.equal(normalizeReasoningCapability({ min: 128, max: 20000, dynamic_allowed: true, levels: [] }), null);
});

test("reasoning preferences are provider-scoped and stale values fall back to Auto", () => {
  const capability = { supported: true, levels: ["none", "low", "medium", "high"], source: "model-definitions" };
  const selected = resolveReasoningPreference(model, capability, {
    [modelCapabilityKey(model)]: "high",
    [modelCapabilityKey({ ...model, provider: "custom-b" })]: "low",
  });
  assert.equal(selected.selectedLevel, "high");

  const stale = resolveReasoningPreference(model, capability, { [modelCapabilityKey(model)]: "xhigh" });
  assert.equal(stale.selectedLevel, null);
  assert.match(stale.note, /no longer advertised/);
});

test("reasoning levels are exported as metadata without a default override", () => {
  const entry = toCopilotModelEntry(
    {
      ...model,
      capabilities: { vision: false, source: "catalog" },
      reasoning: { supported: true, levels: ["none", "low", "medium", "high"], selectedLevel: "none" },
    },
    { proxyUrl: "http://127.0.0.1:8317" }
  );

  assert.equal(entry.thinking, true);
  assert.deepEqual(entry.supportsReasoningEffort, ["none", "low", "medium", "high"]);
  assert.equal(entry.reasoningEffortFormat, "chat-completions");
  assert.equal("modelOptions" in entry, false);
});

test("Auto reasoning omits the model option", () => {
  const entry = toCopilotModelEntry(
    {
      ...model,
      capabilities: { vision: false, source: "catalog" },
      reasoning: { supported: true, levels: ["low", "medium", "high"], selectedLevel: null },
    },
    { proxyUrl: "http://127.0.0.1:8317" }
  );

  assert.equal("modelOptions" in entry, false);
  assert.deepEqual(entry.supportsReasoningEffort, ["low", "medium", "high"]);
});