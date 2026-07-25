// Accent color per provider "lobe". Values are plain rgb triples so the canvas
// can build rgba() strings at varying alpha for glow/decay without parsing.
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const PROVIDER_RGB: Record<string, Rgb> = {
  anthropic: { r: 217, g: 149, b: 74 }, // amber
  claude: { r: 217, g: 149, b: 74 }, // amber (alias)
  antigravity: { r: 116, g: 199, b: 236 }, // cyan
  gemini: { r: 116, g: 199, b: 236 }, // cyan
  google: { r: 116, g: 199, b: 236 }, // cyan
  openai: { r: 80, g: 200, b: 140 }, // emerald
  codex: { r: 80, g: 200, b: 140 }, // emerald
  gpt: { r: 80, g: 200, b: 140 }, // emerald
  xai: { r: 168, g: 130, b: 240 }, // violet
  grok: { r: 168, g: 130, b: 240 }, // violet
};

const FALLBACK: Rgb = { r: 148, g: 163, b: 184 }; // slate

/** Provider accent color, matched case-insensitively with a slate fallback. */
export function colorFor(provider: string): Rgb {
  return PROVIDER_RGB[(provider || "").toLowerCase()] ?? FALLBACK;
}

export function rgba({ r, g, b }: Rgb, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
