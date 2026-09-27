import { test } from "node:test";
import assert from "node:assert/strict";
import { toolTabForPage } from "./tools-navigation";

test("legacy RTK and Ponytail links open their respective tabs", () => {
  assert.equal(toolTabForPage("rtk"), "rtk");
  assert.equal(toolTabForPage("ponytail"), "ponytail");
  assert.equal(toolTabForPage("tools"), null);
  assert.equal(toolTabForPage("models"), null);
});