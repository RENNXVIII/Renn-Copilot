import * as fs from "node:fs";
import { type ChatLanguageModelProvider } from "./provider-entry";

export function readModelProviders(filePath: string): ChatLanguageModelProvider[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("chatLanguageModels.json must contain a JSON array; refusing to overwrite it.");
  return parsed as ChatLanguageModelProvider[];
}