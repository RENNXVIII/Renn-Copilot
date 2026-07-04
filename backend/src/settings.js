import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Resolves ~ to the user's home directory and expands env-style defaults.
 * Centralized here so every module agrees on where things live.
 */
function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

export const settings = {
  port: Number(process.env.PORT || 4317),

  cliproxyHome: expandHome(process.env.CLIPROXY_HOME || "~/.renn-copilot/cliproxyapi"),
  cliproxyPort: Number(process.env.CLIPROXY_PORT || 8317),
  cliproxyHost: process.env.CLIPROXY_HOST || "127.0.0.1",
  cliproxyVersion: process.env.CLIPROXY_VERSION || "latest",

  // Filled in lazily by cliproxy-manager once it knows/generates the key.
  managementKey: process.env.CLIPROXY_MANAGEMENT_KEY || "",

  // Proxy API key (CLIProxyAPI's top-level "api-keys" entry) used to call its
  // OpenAI-compatible surface (GET /v1/models, etc.) -- separate from the
  // management key, which only guards /v0/management/*.
  proxyApiKey: process.env.CLIPROXY_API_KEY || "",
};

export function ensureDirs() {
  fs.mkdirSync(settings.cliproxyHome, { recursive: true });
  fs.mkdirSync(path.join(settings.cliproxyHome, "auths"), { recursive: true });
}

export function binaryPath() {
  const exe = process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
  return path.join(settings.cliproxyHome, exe);
}

export function configPath() {
  return path.join(settings.cliproxyHome, "config.yaml");
}

export function managementBaseUrl() {
  return `http://${settings.cliproxyHost}:${settings.cliproxyPort}/v0/management`;
}

export function proxyBaseUrl() {
  return `http://${settings.cliproxyHost}:${settings.cliproxyPort}`;
}
