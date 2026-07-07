// Overwritten at build time by scripts/package-vsix.mjs to bake in which
// BYOK vendor string the shipped VSIX uses ("customendpoint" or "customoai")
// -- see extension.ts's PROVIDER_VENDOR. This checked-in default matches
// every release shipped so far, so a plain `npm run package` (no vendor
// arg) keeps producing the known-good build.
export const GENERATED_PROVIDER_VENDOR = "customendpoint";
