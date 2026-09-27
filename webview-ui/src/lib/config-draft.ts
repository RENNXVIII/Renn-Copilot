export function mergeConfigDraft(draft: string, baseline: string | null, incoming: string) {
  return { draft: baseline === null || draft === baseline ? incoming : draft, baseline: incoming };
}