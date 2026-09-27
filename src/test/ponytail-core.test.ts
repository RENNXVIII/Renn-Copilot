import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ponytailStatus, enablePonytail, disablePonytail, ponytailInstructions, LEGACY_PONYTAIL_INSTRUCTIONS } from "../ponytail-core.js";

async function withWorkspace(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "renn-ponytail-test-"));
  try { await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test("enables and disables Ponytail without changing existing Copilot instructions", async () => {
  await withWorkspace(async (dir) => {
    const instructions = path.join(dir, ".github", "copilot-instructions.md");
    const target = path.join(dir, ".github", "instructions", "renn-ponytail.instructions.md");
    await fs.mkdir(path.dirname(instructions));
    await fs.writeFile(instructions, "existing instructions\n");
    assert.deepEqual(await ponytailStatus(dir), { status: "disabled" });
    await enablePonytail(dir, "full");
    assert.deepEqual(await ponytailStatus(dir), { status: "enabled", mode: "full" });
    assert.equal(await fs.readFile(target, "utf8"), ponytailInstructions("full"));
    await enablePonytail(dir, "full");
    await disablePonytail(dir);
    assert.deepEqual(await ponytailStatus(dir), { status: "disabled" });
    assert.equal(await fs.readFile(instructions, "utf8"), "existing instructions\n");
  });
});

test("switches between lite, full and ultra on a Renn-managed file", async () => {
  await withWorkspace(async (dir) => {
    const target = path.join(dir, ".github", "instructions", "renn-ponytail.instructions.md");
    await enablePonytail(dir, "lite");
    assert.deepEqual(await ponytailStatus(dir), { status: "enabled", mode: "lite" });
    await enablePonytail(dir, "ultra");
    assert.deepEqual(await ponytailStatus(dir), { status: "enabled", mode: "ultra" });
    assert.equal(await fs.readFile(target, "utf8"), ponytailInstructions("ultra"));
    assert.notEqual(ponytailInstructions("lite"), ponytailInstructions("ultra"));
  });
});

test("a file written by an earlier version is recognized as full and can switch mode", async () => {
  await withWorkspace(async (dir) => {
    const target = path.join(dir, ".github", "instructions", "renn-ponytail.instructions.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, LEGACY_PONYTAIL_INSTRUCTIONS);
    assert.deepEqual(await ponytailStatus(dir), { status: "enabled", mode: "full" });
    await enablePonytail(dir, "lite");
    assert.deepEqual(await ponytailStatus(dir), { status: "enabled", mode: "lite" });
  });
});

test("rejects an unknown mode", async () => {
  await withWorkspace(async (dir) => {
    await assert.rejects(enablePonytail(dir, "extreme" as never));
  });
});

test("never overwrites or removes a modified or user-owned instruction file", async () => {
  await withWorkspace(async (dir) => {
    const target = path.join(dir, ".github", "instructions", "renn-ponytail.instructions.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "custom\n");
    assert.deepEqual(await ponytailStatus(dir), { status: "conflict" });
    await assert.rejects(enablePonytail(dir, "full"));
    await assert.rejects(disablePonytail(dir));
    assert.equal(await fs.readFile(target, "utf8"), "custom\n");
  });
});

test("refuses symlinked instruction directory", async (t) => {
  await withWorkspace(async (dir) => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "renn-ponytail-other-"));
    try {
      await fs.mkdir(path.join(dir, ".github"));
      try {
        await fs.symlink(elsewhere, path.join(dir, ".github", "instructions"), process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") { t.skip("Symlinks unavailable"); return; }
        throw err;
      }
      await assert.rejects(enablePonytail(dir, "full"));
      await assert.rejects(ponytailStatus(dir));
    } finally { await fs.rm(elsewhere, { recursive: true, force: true }); }
  });
});