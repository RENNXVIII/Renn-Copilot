import { useEffect, useMemo, useRef, useState } from "react";
import type { UsageTokenSummary } from "../../api/client";
import type { Firing, NeuronNode, Synapse } from "./types";
import { buildNodes, diffFirings, recentKey } from "./graph";

// How long a firing animation is kept in state before being pruned. Matched to
// the canvas pulse duration ceiling plus slack for the stagger tail below.
const FIRING_TTL_MS = 3200;

// Spread a batch of newly-revealed firings over time so a poll that surfaces
// several requests flows in as a sequence rather than one synchronized burst.
const STAGGER_MS = 180;

/**
 * Turns polled usage (jalur B) into a live-ish graph:
 *  - nodes/synapses rebuilt only when the node *set* changes (cheap layout).
 *  - firings seeded by diffing recent[] between polls; the very first poll is
 *    absorbed into `seen` without firing, so opening the page doesn't replay
 *    the whole backlog as a burst.
 */
export function useNeuronGraph(usage: UsageTokenSummary | undefined): {
  nodes: NeuronNode[];
  synapses: Synapse[];
  firings: Firing[];
  hasData: boolean;
} {
  const seenRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);
  const [firings, setFirings] = useState<Firing[]>([]);

  const recent = usage?.recent ?? [];
  const byProviderModel = usage?.byProviderModel ?? [];

  // Rebuild nodes only when the identity set changes, not on every poll. The
  // key is the sorted set of provider::model ids plus their request counts.
  const nodeKey = byProviderModel
    .map((r) => `${r.provider}::${r.model}:${r.requests}`)
    .sort()
    .join("|");
  const recentNodeKey = recent
    .map((r) => `${r.provider}::${r.model}`)
    .sort()
    .join("|");

  const { nodes, synapses } = useMemo(
    () => buildNodes(byProviderModel, recent),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeKey, recentNodeKey]
  );

  // Diff recent[] -> new firings on each usage change.
  useEffect(() => {
    if (!usage) return;
    if (!primedRef.current) {
      // First successful poll: remember everything, fire nothing.
      for (const r of recent) seenRef.current.add(recentKey(r));
      primedRef.current = true;
      return;
    }
    const now = performance.now();
    const { firings: fresh, newKeys } = diffFirings(recent, seenRef.current, now, STAGGER_MS);
    if (!fresh.length) return;
    for (const k of newKeys) seenRef.current.add(k);
    // Bound the seen set so it can't grow unbounded across a long session.
    if (seenRef.current.size > 4000) {
      seenRef.current = new Set([...seenRef.current].slice(-2000));
    }
    setFirings((prev) => [...prev, ...fresh]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usage]);

  // Prune expired firings periodically (cheap; independent of the rAF loop).
  useEffect(() => {
    if (!firings.length) return;
    const id = setInterval(() => {
      const cutoff = performance.now() - FIRING_TTL_MS;
      setFirings((prev) => prev.filter((f) => f.startedAt >= cutoff));
    }, 500);
    return () => clearInterval(id);
  }, [firings.length]);

  return { nodes, synapses, firings, hasData: nodes.length > 0 };
}
