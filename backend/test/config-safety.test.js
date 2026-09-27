import { test } from "node:test";
import assert from "node:assert/strict";
import { patchTopLevelList, selectProxyAuthKeys } from "../src/cliproxy-manager.js";
import { providerItemsFromBody } from "../src/routes.js";
import yaml from "js-yaml";

test("proxy auth never silently deletes user keys", () => {
    assert.deepEqual(selectProxyAuthKeys(["own", "other"], "own", true), ["own", "other"]);
    assert.deepEqual(selectProxyAuthKeys(["other"], "own", true), ["other", "own"]);
    assert.deepEqual(selectProxyAuthKeys(["own"], "own", false), []);
    assert.throws(() => selectProxyAuthKeys(["own", "other"], "own", false), /other API keys/);
    assert.throws(() => selectProxyAuthKeys(["other"], "own", false), /other API keys/);
});

test("provider replacement requires an explicit array, including for clearing", () => {
    assert.deepEqual(providerItemsFromBody({ items: [] }), []);
    assert.deepEqual(providerItemsFromBody({ items: [{ name: "example" }] }), [{ name: "example" }]);
    for (const body of [undefined, {}, { items: null }, { items: "oops" }]) {
        assert.throws(() => providerItemsFromBody(body), /items must be an array/);
    }
});

test("block API keys with comments are replaced without leaving stray YAML items", () => {
    const original = 'api-keys:\n  - "first"\n  # keep this comment\n\n  - "second"\nhost: "127.0.0.1"\n';
    const patched = patchTopLevelList(original, "api-keys", ["first", "second", "own"]);
    assert.deepEqual(yaml.load(patched)["api-keys"], ["first", "second", "own"]);
    assert.equal(yaml.load(patched).host, "127.0.0.1");
});