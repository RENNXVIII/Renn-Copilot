/** Ported from dashboard/lib/utils.ts (maskEmail, shortenPath). */
export function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(3, local.length - visible.length))}${domain}`;
}

export function shortenPath(value: string, segments = 2): string {
  if (!value) return value;
  const parts = value.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= segments) return value;
  const sep = value.includes("\\") ? "\\" : "/";
  return `...${sep}${parts.slice(-segments).join(sep)}`;
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(8)}${key.slice(-4)}`;
}
