import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { useNeuronGraph } from "./neuron/useNeuronGraph";
import { NeuronCanvas, type HoverInfo } from "./neuron/NeuronCanvas";
import { colorFor, rgba } from "./neuron/palette";
import { formatNumber } from "../lib/utils";

// Near-live polling cadence. The backend drains CLIProxyAPI's usage-queue on
// its own schedule (~15s), so firings here are honestly "near-live", not
// instant -- polling faster than the drain just wastes requests.
const POLL_MS = 3000;
const USAGE_DAYS = 1;

// Providers shown in the legend, in a stable order.
const LEGEND = [
  { key: "anthropic", label: "Claude" },
  { key: "gemini", label: "Gemini" },
  { key: "openai", label: "Codex / GPT" },
  { key: "xai", label: "xAI / Grok" },
];

/** True while the OS/user prefers reduced motion. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** True while this webview document is actually visible. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function relativeAge(hitTs: number, now: number): string {
  const s = Math.max(0, Math.round((now - hitTs) / 1000));
  if (s < 1) return "just now";
  if (s < 60) return `~${s}s ago`;
  const m = Math.round(s / 60);
  return `~${m}m ago`;
}

export function Neuron() {
  const { data: status } = usePolling(api.getStatus, 4000);
  const serverRunning = status?.running ?? false;
  const visible = usePageVisible();
  const reducedMotion = usePrefersReducedMotion();

  // Only poll while the server is up and the page is visible -- no background
  // network churn when the user is on another tab or VS Code is hidden.
  const pollEnabled = serverRunning && visible;
  const { data: usage, error } = usePolling(() => api.getUsageTokens(USAGE_DAYS), POLL_MS, pollEnabled);

  const { nodes, synapses, firings, hasData } = useNeuronGraph(usage);

  // Recent firing feed (newest first), refreshed on a 1s tick for the "~Ns ago"
  // labels without re-rendering the whole canvas.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!firings.length) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [firings.length]);

  const feed = useMemo(() => {
    return [...firings]
      .sort((a, b) => b.hitTs - a.hitTs)
      .slice(0, 8)
      .map((f) => {
        const node = nodes.find((n) => n.id === f.nodeId);
        return { firing: f, provider: node?.provider ?? "unknown", model: node?.model ?? f.nodeId };
      });
  }, [firings, nodes]);

  const running = pollEnabled && hasData;

  // Hover tooltip: the canvas reports which node is under the pointer (with the
  // viewport coords); we position a detail panel relative to the stage.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const tooltipPos = useMemo(() => {
    if (!hover || !stageRef.current) return null;
    const rect = stageRef.current.getBoundingClientRect();
    return {
      left: clamp(hover.clientX - rect.left + 14, 8, rect.width - 8),
      top: clamp(hover.clientY - rect.top + 14, 8, rect.height - 8),
    };
  }, [hover]);

  return (
    <div className="page">
      <div>
        <h1>Neuron Activity</h1>
        <p className="page-hint">
          A live-ish "brain" of your models. Each neuron is a provider/model; it fires when that model is hit. Sourced
          from CLIProxyAPI usage, so firings are near-live (typically within ~15s), not instant.
        </p>
      </div>

      {!serverRunning && (
        <div className="empty-hint">CLIProxyAPI isn't running, so there's no activity to visualize. Go to Overview and click Start first.</div>
      )}
      {serverRunning && error && <div className="empty-hint">Couldn't load usage: {error.message}</div>}
      {serverRunning && !error && !hasData && (
        <div className="empty-hint">
          No model activity yet. Send a request from Copilot Chat (or ensure usage-statistics is enabled in Config) and
          neurons will light up here.
        </div>
      )}

      {serverRunning && hasData && (
        <div className="card neuron-card">
          <div className="neuron-stage" ref={stageRef}>
            <NeuronCanvas
              nodes={nodes}
              synapses={synapses}
              firings={firings}
              running={running}
              reducedMotion={reducedMotion}
              onHoverNode={setHover}
            />
            {!visible && <div className="neuron-paused">Paused (tab hidden)</div>}
            {hover && tooltipPos && (
              <div className="neuron-tooltip" style={{ left: tooltipPos.left, top: tooltipPos.top }}>
                <div className="neuron-tooltip-title">
                  <span className="neuron-legend-dot" style={{ background: rgba(colorFor(hover.node.provider), 0.85) }} />
                  {hover.node.model}
                </div>
                <div className="neuron-tooltip-sub">{hover.node.provider}</div>
                <div className="neuron-tooltip-grid">
                  {hover.node.account && (
                    <>
                      <span>Account</span>
                      <span>{hover.node.account}</span>
                    </>
                  )}
                  <span>Requests</span>
                  <span>{formatNumber(hover.node.requests)}</span>
                  <span>Input tokens</span>
                  <span>{formatNumber(hover.node.inputTokens)}</span>
                  <span>Output tokens</span>
                  <span>{formatNumber(hover.node.outputTokens)}</span>
                  <span>Total tokens</span>
                  <span>{formatNumber(hover.node.totalTokens)}</span>
                  {hover.node.avgLatencyMs != null && (
                    <>
                      <span>Last latency</span>
                      <span>{Math.round(hover.node.avgLatencyMs)}ms</span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="neuron-legend">
            {LEGEND.map((l) => (
              <span key={l.key} className="neuron-legend-item">
                <span className="neuron-legend-dot" style={{ background: rgba(colorFor(l.key), 0.85) }} />
                {l.label}
              </span>
            ))}
            <span className="neuron-legend-item">
              <span className="neuron-legend-dot" style={{ background: "rgba(232,80,80,0.85)" }} />
              Failed
            </span>
          </div>

          <div className="neuron-meta">
            <span className="badge neutral">{nodes.length} neurons</span>
            <span className="card-desc">Node size ∝ cumulative requests · brightness fades as a model goes idle.</span>
          </div>

          <div className="neuron-feed">
            <div className="card-desc" style={{ marginBottom: 6 }}>
              Recent firings
            </div>
            {feed.length === 0 && <div className="card-desc">Waiting for the next request…</div>}
            {feed.map(({ firing, provider, model }) => (
              <div key={firing.id} className="neuron-feed-row">
                <span className="neuron-legend-dot" style={{ background: firing.failed ? "rgba(232,80,80,0.85)" : rgba(colorFor(provider), 0.85) }} />
                <span className="neuron-feed-model">{model}</span>
                <span className="cred-row-sub">{provider}</span>
                {firing.account && <span className="cred-row-sub neuron-feed-account">{firing.account}</span>}
                {firing.failed && <span className="badge neutral">failed</span>}
                {(firing.inputTokens != null || firing.outputTokens != null) && (
                  <span className="cred-row-sub" title="Input / output tokens">
                    {formatNumber(firing.inputTokens ?? 0)} in / {formatNumber(firing.outputTokens ?? 0)} out
                  </span>
                )}
                {firing.latencyMs != null && <span className="cred-row-sub">{Math.round(firing.latencyMs)}ms</span>}
                <span className="cred-row-sub neuron-feed-age">{relativeAge(firing.hitTs, now)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
