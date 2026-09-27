import { installSkillFromFiles } from "./skills-core";

export type SkillId = "ui-ux-pro-max" | "humanizer" | `wondel/${string}`;
type TreeEntry = { path: string; type: string; size?: number };

const HEADERS = { "User-Agent": "renn-copilot", Accept: "application/vnd.github+json" };
const SOURCES = {
  "ui-ux-pro-max": { repo: "nextlevelbuilder/ui-ux-pro-max-skill", prefix: ".claude/skills/ui-ux-pro-max/", name: "ui-ux-pro-max" },
  humanizer: { repo: "blader/humanizer", prefix: "", name: "humanizer" },
} as const;

export function resolveSkill(id: string) {
  if (id === "ui-ux-pro-max" || id === "humanizer") return SOURCES[id];
  const name = id.startsWith("wondel/") ? id.slice(7) : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Unknown skill.");
  return { repo: "wondelai/skills", prefix: `${name}/`, name: `wondel-${name}` };
}

async function fetchBytes(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) throw new Error(`Skill source unavailable (${response.status}).`);
  const size = Number(response.headers.get("content-length"));
  if (size > maxBytes) throw new Error("Skill source exceeds size limit.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) { await response.body.cancel().catch(() => undefined); throw new Error("Skill source exceeds size limit."); }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function getTree(repo: string): Promise<{ sha: string; entries: TreeEntry[] }> {
  const metadata = JSON.parse((await fetchBytes(`https://api.github.com/repos/${repo}`, 100_000)).toString("utf8")) as { default_branch?: string };
  if (!metadata.default_branch || !/^[a-zA-Z0-9._/-]+$/.test(metadata.default_branch)) throw new Error("Invalid source branch.");
  const commit = JSON.parse((await fetchBytes(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(metadata.default_branch)}`, 200_000)).toString("utf8")) as { sha?: string };
  if (!commit.sha || !/^[0-9a-f]{40}$/.test(commit.sha)) throw new Error("Invalid source revision.");
  const tree = JSON.parse((await fetchBytes(`https://api.github.com/repos/${repo}/git/trees/${commit.sha}?recursive=1`, 1_500_000)).toString("utf8")) as { truncated?: boolean; tree?: TreeEntry[] };
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("Incomplete skill source listing.");
  return { sha: commit.sha, entries: tree.tree };
}

export async function listWondelSkills(): Promise<string[]> {
  const { entries } = await getTree("wondelai/skills");
  return entries.filter((entry) => entry.type === "blob" && /^[a-z0-9]+(?:-[a-z0-9]+)*\/SKILL\.md$/.test(entry.path))
    .map((entry) => entry.path.split("/")[0]).sort();
}

export async function installSkill(workspace: string, id: string): Promise<void> {
  const { repo, prefix, name } = resolveSkill(id);
  const { sha, entries } = await getTree(repo);
  const relevant = entries.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix) &&
    (repo !== "blader/humanizer" || entry.path === "SKILL.md"));
  if (relevant.length > 150 || !relevant.some((entry) => entry.path === `${prefix}SKILL.md`)) throw new Error("Skill source missing or too large.");
  const total = relevant.reduce((sum, entry) => sum + (entry.size ?? 2_000_001), 0);
  if (total > 12_000_000 || relevant.some((entry) => !entry.size || entry.size > 2_000_000)) throw new Error("Skill source exceeds size limit.");

  const files = new Map<string, Buffer>();
  // Fetch from a pinned commit; never execute remote scripts during installation.
  for (let i = 0; i < relevant.length; i += 5) {
    const batch = relevant.slice(i, i + 5);
    const downloaded = await Promise.all(batch.map(async (entry) => {
      const bytes = await fetchBytes(`https://raw.githubusercontent.com/${repo}/${sha}/${entry.path.split("/").map(encodeURIComponent).join("/")}`, 2_000_000);
      if (bytes.length !== entry.size) throw new Error("Skill source changed during download.");
      return [entry.path.slice(prefix.length), bytes] as const;
    }));
    for (const [relative, bytes] of downloaded) files.set(relative, bytes);
  }
  await installSkillFromFiles(workspace, name, files);
}