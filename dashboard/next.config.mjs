import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dashboard is purely a control panel for a local backend; no need for
  // server rendering against secrets, so plain client components + SWR
  // polling is enough. Left as a normal Next.js app (not static export)
  // so API routes could be added later if useful.

  // The repo root and dashboard/ both have a package-lock.json (root from npm
  // workspaces, dashboard/ from installing here directly), which makes Next.js
  // guess the wrong workspace root. Pin it explicitly so file tracing during
  // `next build` always uses this folder, regardless of lockfiles elsewhere.
  outputFileTracingRoot: __dirname,
  devIndicators: false,
};

export default nextConfig;
