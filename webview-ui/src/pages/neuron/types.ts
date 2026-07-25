import type { RecentUsageRecord, ProviderModelUsage } from "../../api/client";

// One node in the "brain" -- a distinct provider::model pair. Size scales with
// cumulative requests; brightness with recent activity + decay.
export interface NeuronNode {
  id: string; // `${provider}::${model}`
  provider: string;
  model: string;
  requests: number; // cumulative (byProviderModel) -> node size
  lastHitTs: number | null; // wall-clock ms of the most recent seen hit
  lastFailed: boolean;
  avgLatencyMs: number | null;
  // Detail from the most recent seen request for this model, surfaced in the
  // hover tooltip. Cumulative token totals come from byProviderModel.
  account: string | null;
  inputTokens: number; // cumulative input tokens (byProviderModel)
  outputTokens: number; // cumulative output tokens (byProviderModel)
  totalTokens: number; // cumulative total tokens (byProviderModel)
  x: number; // normalized 0..1 layout position
  y: number;
}

// A synapse connecting the central "caller" to a neuron. Pulses travel along it.
export interface Synapse {
  from: string; // "caller" or a node id
  to: string; // node id
}

// A single firing animation seeded from a diff of recent[]. Since this build
// only has jalur B (no proxy-tap), every firing is near-live, not instant --
// labeled honestly as "~Ns ago" in the UI.
export interface Firing {
  id: string; // dedupe key: `${model}|${ts}|${latency}`
  nodeId: string;
  startedAt: number; // performance.now() when the animation began
  failed: boolean;
  latencyMs: number | null;
  hitTs: number; // wall-clock ms the underlying request happened
  // Per-request detail for the "Recent firings" feed. Nulls when the backend
  // couldn't join the account label or the provider didn't report tokens.
  account: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface NeuronGraph {
  nodes: NeuronNode[];
  synapses: Synapse[];
  firings: Firing[];
}

export type { RecentUsageRecord, ProviderModelUsage };
