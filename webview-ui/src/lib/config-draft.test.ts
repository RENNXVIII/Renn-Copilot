import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeConfigDraft } from "./config-draft";

test("polling refreshes only an unedited config draft", () => {
  assert.deepEqual(mergeConfigDraft("old", "old", "updated"), { draft: "updated", baseline: "updated" });
  assert.deepEqual(mergeConfigDraft("my edit", "old", "updated"), { draft: "my edit", baseline: "updated" });
});