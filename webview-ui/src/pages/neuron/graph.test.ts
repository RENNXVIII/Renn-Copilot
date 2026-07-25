import test from "node:test";
import assert from "node:assert/strict";
import { buildNodes, diffFirings, recentKey } from "./graph";
import { layoutNodes, CALLER_ID } from "./layout";
import { colorFor } from "./palette";
import type { ProviderModelUsage, RecentUsageRecord, NeuronNode } from "./types";

function usage(provider: string, model: string, requests: number): ProviderModelUsage {
  return { provider, model, requests, input_tokens: 0, output_tokens: 0, total_tokens: 0 } as ProviderModelUsage;
}

function rec(provider: string, model: string, extra: Partial<RecentUsageRecord> = {}): RecentUsageRecord {
  return {
    timestamp: "2024-01-01T00:00:00.000Z",
    provider,
    model,
    failed: false,
    latency_ms: 100,
    tokens: 0,
    endpoint: "/v1/chat/completions",
    auth_type: "oauth",
    account: "acct",
    ...extra,
  } as RecentUsageRecord;
}

test("buildNodes unions cumulative and recent-only models", () => {
  const { nodes, synapses } = buildNodes(
    [usage("anthropic", "claude-3", 10)],
    [rec("openai", "gpt-4")] // not in cumulative
  );
  const ids = nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["anthropic::claude-3", "openai::gpt-4"]);
  // recent-only node has requests 0
  assert.equal(nodes.find((n) => n.id === "openai::gpt-4")!.requests, 0);
  assert.equal(nodes.find((n) => n.id === "anthropic::claude-3")!.requests, 10);
  // every node has a synapse from the caller hub
  assert.equal(synapses.length, nodes.length);
  assert.ok(synapses.every((s) => s.from === CALLER_ID));
});

test("buildNodes applies newest recent hit info to a node", () => {
  const { nodes } = buildNodes(
    [usage("openai", "gpt-4", 3)],
    [
      rec("openai", "gpt-4", { timestamp: "2024-01-01T00:00:00.000Z", failed: false, latency_ms: 100 }),
      rec("openai", "gpt-4", { timestamp: "2024-01-01T00:00:05.000Z", failed: true, latency_ms: 250 }),
    ]
  );
  const node = nodes.find((n) => n.id === "openai::gpt-4")!;
  assert.equal(node.lastFailed, true);
  assert.equal(node.avgLatencyMs, 250);
  assert.equal(node.lastHitTs, Date.parse("2024-01-01T00:00:05.000Z"));
});

test("diffFirings only fires unseen records and records their keys", () => {
  const seen = new Set<string>();
  const recents = [rec("openai", "gpt-4"), rec("anthropic", "claude-3")];
  const first = diffFirings(recents, seen, 1000);
  assert.equal(first.firings.length, 2);
  // per-request detail is carried onto the firing for the feed
  assert.equal(first.firings[0].account, "acct");
  first.newKeys.forEach((k) => seen.add(k));
  // same batch again -> nothing new
  const second = diffFirings(recents, seen, 2000);
  assert.equal(second.firings.length, 0);
});

test("diffFirings falls back to now for unparseable timestamps", () => {
  const { firings } = diffFirings([rec("xai", "grok", { timestamp: null })], new Set(), 5000);
  assert.equal(firings.length, 1);
  assert.equal(firings[0].hitTs, 5000);
  assert.equal(firings[0].startedAt, 5000);
});

test("recentKey is stable and null-safe", () => {
  const a = recentKey(rec("openai", "gpt-4", { timestamp: null, latency_ms: null }));
  const b = recentKey(rec("openai", "gpt-4", { timestamp: null, latency_ms: null }));
  assert.equal(a, b);
  assert.equal(a, "openai|gpt-4|null|null");
});

test("layoutNodes centers the caller and normalizes coords", () => {
  const nodes: NeuronNode[] = [
    { id: "anthropic::claude-3", provider: "anthropic", model: "claude-3", requests: 10, lastHitTs: null, lastFailed: false, avgLatencyMs: null, account: null, inputTokens: 0, outputTokens: 0, totalTokens: 0, x: 0.5, y: 0.5 },
    { id: "openai::gpt-4", provider: "openai", model: "gpt-4", requests: 5, lastHitTs: null, lastFailed: false, avgLatencyMs: null, account: null, inputTokens: 0, outputTokens: 0, totalTokens: 0, x: 0.5, y: 0.5 },
  ];
  const pos = layoutNodes(nodes);
  const caller = pos.get(CALLER_ID)!;
  assert.deepEqual(caller, { x: 0.5, y: 0.5 });
  for (const n of nodes) {
    const p = pos.get(n.id)!;
    assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
  }
});

test("layoutNodes is deterministic", () => {
  const nodes: NeuronNode[] = [
    { id: "openai::gpt-4", provider: "openai", model: "gpt-4", requests: 5, lastHitTs: null, lastFailed: false, avgLatencyMs: null, account: null, inputTokens: 0, outputTokens: 0, totalTokens: 0, x: 0.5, y: 0.5 },
  ];
  const a = layoutNodes(nodes).get("openai::gpt-4")!;
  const b = layoutNodes(nodes).get("openai::gpt-4")!;
  assert.deepEqual(a, b);
});

test("colorFor is case-insensitive with a fallback", () => {
  const claude = colorFor("Anthropic");
  const claudeLower = colorFor("anthropic");
  assert.deepEqual(claude, claudeLower);
  const fallback = colorFor("totally-unknown-provider");
  assert.ok(fallback && typeof fallback.r === "number");
});
