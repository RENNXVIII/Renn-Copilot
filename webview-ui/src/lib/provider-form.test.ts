import { test } from "node:test";
import assert from "node:assert/strict";
import { updateCustomProvider, updateXaiProvider } from "./provider-form";

test("editing custom provider retains secondary keys and per-key settings", () => {
    const previous = { name: "test", "base-url": "https://example.test", "api-key-entries": [{ "api-key": "one", "proxy-url": "local" }, { "api-key": "two" }], priority: 4, models: [{ name: "old" }] };
    const updated = updateCustomProvider(previous, "renamed", "https://example.test", "new", [{ name: "new-model" }]);
    assert.deepEqual(updated["api-key-entries"], [{ "api-key": "new", "proxy-url": "local" }, { "api-key": "two" }]);
    assert.equal(updated.priority, 4);
});

test("editing xAI key retains provider settings, sibling keys and clears models explicitly", () => {
    const previous = { name: "xai", "base-url": "https://api.x.ai/v1", priority: 3, models: [{ name: "old" }], "api-key-entries": [{ "api-key": "one", "proxy-url": "local" }, { "api-key": "two" }] };
    const updated = updateXaiProvider(previous, 0, "new", []);
    assert.deepEqual(updated["api-key-entries"], [{ "api-key": "new", "proxy-url": "local" }, { "api-key": "two" }]);
    assert.deepEqual(updated.models, []);
    assert.equal(updated.priority, 3);
});