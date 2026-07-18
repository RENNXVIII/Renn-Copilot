import test from "node:test";
import assert from "node:assert/strict";
import {
  buildModelList,
  mergeEnabledModels,
  migrateLegacyVisionCapability,
  modelCapabilityKey,
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