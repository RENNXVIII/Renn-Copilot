import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inspectSkill, removeSkill, installSkillFromFiles, skillTarget } from "../skills-core.js";

async function fixture(run: (workspace: string) => Promise<void>) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "renn-skills-"));
  try { await run(workspace); } finally { await fs.rm(workspace, { recursive: true, force: true }); }
}

const files = new Map([
  ["SKILL.md", Buffer.from("---\nname: humanizer\ndescription: Test\n---\nText\n")],
  ["references/notes.md", Buffer.from("Reference\n")],
]);

test("install and remove a skill without touching adjacent skills", async () => fixture(async (workspace) => {
  const adjacent = skillTarget(workspace, "another");
  await fs.mkdir(adjacent, { recursive: true });
  await fs.writeFile(path.join(adjacent, "SKILL.md"), "user skill");
  assert.equal(await inspectSkill(workspace, "humanizer"), "not-installed");
  await installSkillFromFiles(workspace, "humanizer", files);
  assert.equal(await inspectSkill(workspace, "humanizer"), "installed");
  assert.equal(await fs.readFile(path.join(skillTarget(workspace, "humanizer"), "references", "notes.md"), "utf8"), "Reference\n");
  await assert.rejects(installSkillFromFiles(workspace, "humanizer", files));
  await removeSkill(workspace, "humanizer");
  assert.equal(await inspectSkill(workspace, "humanizer"), "not-installed");
  assert.equal(await fs.readFile(path.join(adjacent, "SKILL.md"), "utf8"), "user skill");
}));

test("refuses removal after a file is changed or added", async () => fixture(async (workspace) => {
  await installSkillFromFiles(workspace, "humanizer", files);
  const target = skillTarget(workspace, "humanizer");
  await fs.writeFile(path.join(target, "SKILL.md"), "user edit");
  assert.equal(await inspectSkill(workspace, "humanizer"), "conflict");
  await assert.rejects(removeSkill(workspace, "humanizer"));
  await fs.writeFile(path.join(target, "SKILL.md"), files.get("SKILL.md")!);
  await fs.writeFile(path.join(target, "extra.txt"), "user file");
  await assert.rejects(removeSkill(workspace, "humanizer"));
}));

test("rejects path traversal and symlinked parent folders", async (t) => fixture(async (workspace) => {
  await assert.rejects(installSkillFromFiles(workspace, "../evil", files));
  await assert.rejects(installSkillFromFiles(workspace, "humanizer", new Map([["../bad", Buffer.from("x")]])));
  const github = path.join(workspace, ".github");
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "renn-skills-other-"));
  try {
    try { await fs.symlink(other, github, process.platform === "win32" ? "junction" : "dir"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "EPERM") { t.skip("Symlinks unavailable"); return; } throw err; }
    await assert.rejects(installSkillFromFiles(workspace, "humanizer", files));
  } finally { await fs.rm(other, { recursive: true, force: true }); }
}));

test("extra empty directory prevents removal before any files are deleted", async () => fixture(async (workspace) => {
  await installSkillFromFiles(workspace, "humanizer", files);
  const target = skillTarget(workspace, "humanizer");
  await fs.mkdir(path.join(target, "my-empty-folder"));
  assert.equal(await inspectSkill(workspace, "humanizer"), "conflict");
  await assert.rejects(removeSkill(workspace, "humanizer"));
  assert.equal(await fs.readFile(path.join(target, "SKILL.md"), "utf8"), files.get("SKILL.md")!.toString());
  await fs.rmdir(path.join(target, "my-empty-folder"));
  await removeSkill(workspace, "humanizer");
}));