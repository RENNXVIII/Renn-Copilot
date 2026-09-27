import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const MARKER = ".renn-copilot-skill.json";
export type SkillState = "installed" | "not-installed" | "conflict";

export function skillTarget(workspace: string, name: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Invalid skill name.");
  return path.join(workspace, ".github", "skills", name);
}

function validRelative(relative: string): boolean {
  return relative.length > 0 && relative.length < 240 && !relative.includes("\\") &&
    relative.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== MARKER && !part.includes(":"));
}

async function safeParents(workspace: string) {
  for (const folder of [".github", path.join(".github", "skills")]) {
    try {
      const stat = await fs.lstat(path.join(workspace, folder));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Linked or invalid skill directory; refusing to change workspace files.");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function ownedFiles(target: string): Promise<string[] | null> {
  let hashes: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(target, MARKER), "utf8"));
    if (!parsed || typeof parsed !== "object" || !("files" in parsed)) return null;
    hashes = (parsed as { files: Record<string, string> }).files;
    if (!hashes || typeof hashes !== "object" || Array.isArray(hashes) || !Object.keys(hashes).length) return null;
  } catch { return null; }

  const paths: string[] = [];
  const directories = new Set<string>();
  async function walk(dir: string, prefix: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error("Unmanaged skill entry.");
      if (entry.isDirectory()) {
        directories.add(relative);
        await walk(path.join(dir, entry.name), relative);
      }
      else if (relative !== MARKER) paths.push(relative);
    }
  }
  try {
    await walk(target, "");
    if (paths.length !== Object.keys(hashes).length) return null;
    const expectedDirectories = new Set(paths.flatMap((relative) => {
      const parts = relative.split("/").slice(0, -1);
      return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
    }));
    if (directories.size !== expectedDirectories.size || [...directories].some((dir) => !expectedDirectories.has(dir))) return null;
    for (const relative of paths) {
      if (!validRelative(relative) || typeof hashes[relative] !== "string" ||
          digest(await fs.readFile(path.join(target, ...relative.split("/")))) !== hashes[relative]) return null;
    }
    return paths;
  } catch { return null; }
}

export async function inspectSkill(workspace: string, name: string): Promise<SkillState> {
  await safeParents(workspace);
  const target = skillTarget(workspace, name);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "conflict";
    return await ownedFiles(target) ? "installed" : "conflict";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "not-installed";
    throw err;
  }
}

export async function installSkillFromFiles(workspace: string, name: string, files: Map<string, Buffer>): Promise<void> {
  const target = skillTarget(workspace, name);
  if (!files.has("SKILL.md") || files.size > 150) throw new Error("Missing SKILL.md or too many skill files.");
  let total = 0;
  for (const [relative, bytes] of files) {
    if (!validRelative(relative) || !Buffer.isBuffer(bytes) || bytes.length > 2_000_000) throw new Error("Invalid skill file.");
    total += bytes.length;
  }
  if (total > 12_000_000) throw new Error("Skill is too large.");
  if (await inspectSkill(workspace, name) !== "not-installed") throw new Error("Skill directory already exists; refusing to overwrite it.");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await safeParents(workspace);
  await fs.mkdir(target); // atomic: fail if another process creates it
  try {
    const hashes: Record<string, string> = Object.create(null);
    for (const [relative, bytes] of files) {
      const dest = path.join(target, ...relative.split("/"));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, bytes, { flag: "wx" });
      hashes[relative] = digest(bytes);
    }
    await fs.writeFile(path.join(target, MARKER), JSON.stringify({ files: hashes }, null, 2), { flag: "wx" });
  } catch (err) {
    // A partial install is left for manual inspection if another process changed it.
    // Never recursively delete an unverified directory in this error path.
    throw err;
  }
}

export async function removeSkill(workspace: string, name: string): Promise<void> {
  if (await inspectSkill(workspace, name) !== "installed") throw new Error("Skill is not managed by Renn or was modified; refusing to remove it.");
  const target = skillTarget(workspace, name);
  // Recheck immediately before deletion, including symlink checks on every file.
  const paths = await ownedFiles(target);
  if (!paths) throw new Error("Skill changed; refusing to remove it.");
  const quarantine = path.join(path.dirname(target), `.renn-removing-${name}-${randomUUID()}`);
  await fs.rename(target, quarantine);
  if (!await ownedFiles(quarantine)) {
    await fs.rename(quarantine, target);
    throw new Error("Skill changed during removal; no files were deleted.");
  }
  // From here on the original skill path is free. A failed cleanup leaves a
  // named quarantine for manual recovery rather than a half-deleted skill.
  for (const relative of paths) await fs.unlink(path.join(quarantine, ...relative.split("/")));
  await fs.unlink(path.join(quarantine, MARKER));
  const directories = new Set(paths.flatMap((relative) => {
    const parts = relative.split("/").slice(0, -1);
    return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  }));
  for (const relative of [...directories].sort((a, b) => b.length - a.length)) {
    await fs.rmdir(path.join(quarantine, ...relative.split("/")));
  }
  await fs.rmdir(quarantine);
}