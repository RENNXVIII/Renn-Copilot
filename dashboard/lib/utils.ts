import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Collapses a local filesystem path down to its last couple of segments so
 * the dashboard doesn't print a full path (which usually embeds the OS
 * username) front and center, e.g. "C:\Users\renn\.cliproxyapi" -> "...\.cliproxyapi".
 */
export function shortenPath(value: string, segments = 2): string {
  if (!value) return value;
  const parts = value.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= segments) return value;
  return `...${value.includes("\\") ? "\\" : "/"}${parts.slice(-segments).join(value.includes("\\") ? "\\" : "/")}`;
}

/**
 * Masks the local part of an email so the full address isn't visible at a
 * glance (e.g. during a screen share or screenshot). Keeps the first 2 chars
 * and the domain intact: "aetherverse101@gmail.com" -> "ae•••••••@gmail.com".
 * Falls back to returning non-email strings (like a custom account name)
 * unchanged.
 */
export function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(3, local.length - visible.length))}${domain}`;
}
