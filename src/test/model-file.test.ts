import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readModelProviders } from "../model-file.js";

test("invalid or non-array model file is rejected without modifying it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renn-model-file-"));
  const file = path.join(dir, "models.json");
  try {
    for (const text of ["{broken", "{}", "null"]) {
      fs.writeFileSync(file, text);
      assert.throws(() => readModelProviders(file));
      assert.equal(fs.readFileSync(file, "utf8"), text);
    }
    fs.writeFileSync(file, "[]");
    assert.deepEqual(readModelProviders(file), []);
    fs.rmSync(file);
    assert.deepEqual(readModelProviders(file), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});