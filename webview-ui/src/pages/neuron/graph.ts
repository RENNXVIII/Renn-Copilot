import type { NeuronNode, Synapse, RecentUsageRecord, ProviderModelUsage, Firing } from "./types";
import { withPositions, CALLER_ID } from "./layout";

/** Stable dedupe key for a recent[] record (timestamp can be null). */
export function recentKey(r: RecentUsageRecord): string {
  const ts = r.timestamp ?? "null";
  const lat = r.latency_ms ?? "null";
  return `${r.provider}|${r.model}|${ts}|${lat}`;
}

function nodeId(provider: string, model: string): string {
  return `${provider}::${model}`;
}

/**
 * Builds the node/synapse set from cumulative usage (byProviderModel) unioned
 * with any provider::model seen in recent[]. Positions are laid out radially.
 * Pure -- no time/DOM dependency, so it's unit-testable.
 */
export function buildNodes(
  byProviderModel: ProviderModelUsage[],
  recent: RecentUsageRecord[]
): { nodes: NeuronNode[]; synapses: Synapse[] } {
  const map = new Map<string, NeuronNode>();

  for (const row of byProviderModel) {
    const id = nodeId(row.provider, row.model);
    map.set(id, {
      id,
      provider: row.provider,
      model: row.model,
      requests: row.requests || 0,
      lastHitTs: null,
      lastFailed: false,
      avgLatencyMs: null,
      account: null,
      inputTokens: row.input_tokens || 0,
      outputTokens: row.output_tokens || 0,
      totalTokens: row.total_tokens || 0,
      x: 0.5,
      y: 0.5,
    });
  }

  // recent[] may contain a provider::model not present in the cumulative
  // table yet (fresh model, or usage-stats lag) -- add it with requests 0.
  for (const r of recent) {
    const id = nodeId(r.provider, r.model);
    if (!map.has(id)) {
      map.set(id, {
        id,
        provider: r.provider,
        model: r.model,
        requests: 0,
        lastHitTs: null,
        lastFailed: false,
        avgLatencyMs: null,
        account: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        x: 0.5,
        y: 0.5,
      });
    }
    const node = map.get(id)!;
    const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (Number.isFinite(ts) && (node.lastHitTs === null || ts > node.lastHitTs)) {
      node.lastHitTs = ts;
      node.lastFailed = r.failed;
      node.avgLatencyMs = r.latency_ms ?? node.avgLatencyMs;
      node.account = r.account ?? node.account;
    }
  }

  const nodes = withPositions([...map.values()]);
  const synapses: Synapse[] = nodes.map((n) => ({ from: CALLER_ID, to: n.id }));
  return { nodes, synapses };
}

/**
 * Diffs the newest recent[] against keys already seen and returns firings for
 * the new records only. `now` is injected (performance.now()) so this stays
 * pure/testable. Records with an unparseable timestamp still fire (hitTs=now).
 *
 * `staggerMs` spreads a batch of new firings out in time (ordered by the
 * underlying request timestamp) so a poll that reveals several requests at
 * once flows in as a sequence instead of one synchronized burst. This is
 * purely a presentation cue; the honest "~Ns ago" label still comes from
 * hitTs. Pass 0 to disable (used in tests).
 */
export function diffFirings(
  recent: RecentUsageRecord[],
  seen: Set<string>,
  now: number,
  staggerMs = 0
): { firings: Firing[]; newKeys: string[] } {
  const firings: Firing[] = [];
  const newKeys: string[] = [];
  for (const r of recent) {
    const key = recentKey(r);
    if (seen.has(key)) continue;
    newKeys.push(key);
    const parsed = r.timestamp ? Date.parse(r.timestamp) : NaN;
    firings.push({
      id: key,
      nodeId: nodeId(r.provider, r.model),
      startedAt: now,
      failed: r.failed,
      latencyMs: r.latency_ms,
      hitTs: Number.isFinite(parsed) ? parsed : now,
      account: r.account ?? null,
      inputTokens: r.tokens?.input_tokens ?? null,
      outputTokens: r.tokens?.output_tokens ?? null,
    });
  }
  if (staggerMs > 0 && firings.length > 1) {
    // Order by real request time (oldest first) so the sequence mirrors the
    // actual arrival order, then offset each start by a capped step.
    firings.sort((a, b) => a.hitTs - b.hitTs);
    const step = Math.min(staggerMs, 1200 / firings.length);
    firings.forEach((f, i) => {
      f.startedAt = now + i * step;
    });
  }
  return { firings, newKeys };
}
