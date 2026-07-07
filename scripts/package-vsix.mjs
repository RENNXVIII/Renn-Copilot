// Builds a .vsix with a specific BYOK vendor string baked into
// src/generated-provider.ts (see extension.ts's PROVIDER_VENDOR). Two VS
// Code BYOK provider types exist ("customendpoint" / Custom Endpoint,
// "customoai" / OpenAI-compatible) with different platform support, so this
// produces one .vsix per vendor instead of picking just one at build time.
//
// Usage: node scripts/package-vsix.mjs <customendpoint|customoai>
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALID_VENDORS = new Set(["customendpoint", "customoai"]);
const DEFAULT_VENDOR = "customendpoint"; // matches src/generated-provider.ts's checked-in default
const vendor = process.argv[2];

if (!VALID_VENDORS.has(vendor)) {
  console.error("Usage: node scripts/package-vsix.mjs <customendpoint|customoai>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerFile = path.join(root, "src", "generated-provider.ts");
const outDir = path.join(root, "dist-vsix");

try {
  await writeProviderVendor(vendor);
  await mkdir(outDir, { recursive: true });
  const outputFile = path.join(outDir, `${await packageName()}-${vendor}.vsix`);

  await run("npm", ["run", "backend:install"]);
  await run("npm", ["run", "webview:install"]);
  await run("npm", ["run", "webview:build"]);
  await run("npm", ["exec", "--", "vsce", "package", "--allow-missing-repository", "--out", outputFile]);

  console.log(`\nBuilt ${outputFile}`);
} finally {
  // Always leave the working tree back on the checked-in default, so a
  // plain `npm run package` (or `npm run compile` while iterating) after
  // running this script doesn't silently pick up whichever vendor was built
  // last -- that's exactly the bug this whole setup is meant to avoid.
  await writeProviderVendor(DEFAULT_VENDOR);
}

async function writeProviderVendor(value) {
  await writeFile(
    providerFile,
    `// Overwritten at build time by scripts/package-vsix.mjs to bake in which\n` +
      `// BYOK vendor string the shipped VSIX uses ("customendpoint" or "customoai")\n` +
      `// -- see extension.ts's PROVIDER_VENDOR. This checked-in default matches\n` +
      `// every release shipped so far, so a plain \`npm run package\` (no vendor\n` +
      `// arg) keeps producing the known-good build.\n` +
      `export const GENERATED_PROVIDER_VENDOR: "customendpoint" | "customoai" = ${JSON.stringify(value)};\n`,
    "utf8"
  );
}

async function packageName() {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  return `${pkg.name}-${pkg.version}`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}
