import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_NAME,
  PROVIDER_VENDOR,
  API_TYPE,
  upsertProviderEntry,
  stripProviderEntry,
  maskEmail,
  type ChatLanguageModelProvider,
  type RemoteModelEntry,
} from "../provider-entry";

const model: RemoteModelEntry = {
  id: "gpt-x",
  name: "GPT X",
  url: "http://127.0.0.1:4317/v1/chat/completions",
};

const otherProvider: ChatLanguageModelProvider = {
  name: "Some Other Provider",
  vendor: "openai",
  models: [{ id: "o", name: "O", url: "http://example/v1" }],
};

test("upsert creates our entry when absent, leaving others untouched", () => {
  const { providers, created, changed } = upsertProviderEntry([otherProvider], [model], "key123");
  assert.equal(created, true);
  assert.equal(changed, true);
  assert.equal(providers.length, 2);
  // Original array not mutated.
  const ours = providers.find((p) => p.name === PROVIDER_NAME && p.vendor === PROVIDER_VENDOR);
  assert.ok(ours);
  assert.equal(ours!.apiType, API_TYPE);
  assert.equal(ours!.apiKey, "key123");
  assert.deepEqual(ours!.models, [model]);
  // The unrelated provider survived.
  assert.ok(providers.some((p) => p.name === "Some Other Provider"));
});

test("upsert is a no-op (changed=false) when the entry is byte-identical", () => {
  const first = upsertProviderEntry([], [model], "key123");
  const second = upsertProviderEntry(first.providers, [model], "key123");
  assert.equal(second.changed, false);
  assert.equal(second.created, false);
  // Same array reference returned so the caller can skip the file write.
  assert.equal(second.providers, first.providers);
});

test("upsert updates in place when models change", () => {
  const first = upsertProviderEntry([], [model], "key123");
  const model2: RemoteModelEntry = { ...model, id: "gpt-y", name: "GPT Y" };
  const second = upsertProviderEntry(first.providers, [model2], "key123");
  assert.equal(second.created, false);
  assert.equal(second.changed, true);
  assert.equal(second.providers.length, 1);
  assert.deepEqual(second.providers[0].models, [model2]);
});

test("upsert omits apiKey entirely when empty", () => {
  const { providers } = upsertProviderEntry([], [model], "");
  assert.ok(!("apiKey" in providers[0]));
});

test("strip removes only our entry", () => {
  const seeded = upsertProviderEntry([otherProvider], [model], "k").providers;
  const { providers, removed } = stripProviderEntry(seeded);
  assert.equal(removed, true);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].name, "Some Other Provider");
});

test("strip is a no-op when our entry is absent", () => {
  const { providers, removed } = stripProviderEntry([otherProvider]);
  assert.equal(removed, false);
  assert.equal(providers, providers);
  assert.equal(providers.length, 1);
});

test("upsert then strip is idempotent round-trip", () => {
  const created = upsertProviderEntry([otherProvider], [model], "k");
  const stripped = stripProviderEntry(created.providers);
  assert.equal(stripped.removed, true);
  // Back to just the other provider.
  assert.deepEqual(
    stripped.providers.map((p) => p.name),
    ["Some Other Provider"]
  );
  // Stripping again does nothing.
  assert.equal(stripProviderEntry(stripped.providers).removed, false);
});

test("maskEmail hides the local part but keeps domain", () => {
  const masked = maskEmail("johndoe@example.com");
  assert.ok(masked.startsWith("jo"));
  assert.ok(masked.endsWith("@example.com"));
  assert.ok(!masked.includes("hndoe"));
});

test("maskEmail passes non-emails through unchanged", () => {
  assert.equal(maskEmail("not-an-email"), "not-an-email");
  assert.equal(maskEmail("@leading"), "@leading");
});
