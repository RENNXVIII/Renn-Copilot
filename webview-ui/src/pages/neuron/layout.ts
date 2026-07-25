import type { NeuronNode } from "./types";

// Deterministic radial layout: the "caller" sits at the center (0.5, 0.5);
// each provider gets an angular sector; its models spread along that sector at
// radii that shrink as a model's cumulative request share grows (busier models
// sit a touch closer in, but never overlap the hub). Positions are normalized
// 0..1 so the canvas can scale them to any pixel size / devicePixelRatio.
//
// Pure + deterministic: same input node set -> same coordinates, so it can be
// unit-tested and only recomputed when the *set* of nodes changes.
export const CALLER_ID = "caller";

interface LayoutInput {
  id: string;
  provider: string;
  requests: number;
}

export function layoutNodes<T extends LayoutInput>(nodes: T[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  positions.set(CALLER_ID, { x: 0.5, y: 0.5 });
  if (!nodes.length) return positions;

  // Group by provider, providers sorted for stability.
  const byProvider = new Map<string, T[]>();
  for (const n of nodes) {
    const key = n.provider || "unknown";
    const list = byProvider.get(key);
    if (list) list.push(n);
    else byProvider.set(key, [n]);
  }
  const providers = [...byProvider.keys()].sort();
  const sectorCount = providers.length;

  providers.forEach((provider, pi) => {
    const models = byProvider.get(provider)!.slice().sort((a, b) => a.id.localeCompare(b.id));
    // Center angle of this provider's sector.
    const sectorCenter = (pi / sectorCount) * Math.PI * 2 - Math.PI / 2;
    const sectorSpread = (Math.PI * 2) / sectorCount;
    const maxRequests = Math.max(1, ...models.map((m) => m.requests || 0));

    models.forEach((m, mi) => {
      // Spread models within the sector; single model -> dead center of sector.
      const t = models.length === 1 ? 0 : mi / (models.length - 1) - 0.5;
      const angle = sectorCenter + t * sectorSpread * 0.72;
      // Busier models pulled slightly inward (share 0..1 -> radius 0.42..0.30).
      const share = (m.requests || 0) / maxRequests;
      const radius = 0.42 - share * 0.12;
      positions.set(m.id, {
        x: 0.5 + Math.cos(angle) * radius,
        y: 0.5 + Math.sin(angle) * radius,
      });
    });
  });

  return positions;
}

/** Applies computed positions onto nodes, leaving the array order intact. */
export function withPositions(nodes: NeuronNode[]): NeuronNode[] {
  const pos = layoutNodes(nodes);
  return nodes.map((n) => {
    const p = pos.get(n.id);
    return p ? { ...n, x: p.x, y: p.y } : n;
  });
}
