import { useEffect, useRef } from "react";
import type { Firing, NeuronNode, Synapse } from "./types";
import { colorFor, rgba } from "./palette";

// Node + the client-space (viewport) point to anchor a tooltip near it.
export interface HoverInfo {
  node: NeuronNode;
  clientX: number;
  clientY: number;
}

interface Props {
  nodes: NeuronNode[];
  synapses: Synapse[];
  firings: Firing[];
  // When false (server stopped / page hidden) the rAF loop halts entirely.
  running: boolean;
  reducedMotion: boolean;
  // Fired when the pointer hovers a node (or null when it leaves all nodes) so
  // the page can render a detail tooltip. Optional.
  onHoverNode?: (info: HoverInfo | null) => void;
}

const PULSE_MIN_MS = 400;
const PULSE_MAX_MS = 1500;
const RESTING_DECAY_MS = 8000; // brightness fully decays this long after last hit

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function pulseDuration(latencyMs: number | null): number {
  if (latencyMs === null || !Number.isFinite(latencyMs)) return 900;
  return clamp(latencyMs, PULSE_MIN_MS, PULSE_MAX_MS);
}

function nodeRadius(requests: number, maxRequests: number): number {
  const share = maxRequests > 0 ? requests / maxRequests : 0;
  return 5 + Math.sqrt(share) * 13; // 5..18 px
}

// Latency "heat": 0 for a snappy response, 1 for a slow one. Used to warm the
// color and to decide whether a request is slow enough to label with its ms.
// The window (250ms..4s) covers the common range of provider response times.
const LATENCY_COOL_MS = 250;
const LATENCY_HOT_MS = 4000;
function latencyHeat(latencyMs: number | null): number {
  if (latencyMs === null || !Number.isFinite(latencyMs)) return 0;
  return clamp((latencyMs - LATENCY_COOL_MS) / (LATENCY_HOT_MS - LATENCY_COOL_MS), 0, 1);
}

type Rgb = { r: number; g: number; b: number };
const HEAT_RGB: Rgb = { r: 240, g: 150, b: 70 }; // warm amber for slow responses

/** Blends a provider color toward the warm heat color by `t` (0..1). */
function warmBlend(base: Rgb, t: number): Rgb {
  return {
    r: Math.round(base.r + (HEAT_RGB.r - base.r) * t),
    g: Math.round(base.g + (HEAT_RGB.g - base.g) * t),
    b: Math.round(base.b + (HEAT_RGB.b - base.b) * t),
  };
}

/** Compact ms label: "820ms" under a second, "2.4s" above. */
function latencyLabel(latencyMs: number): string {
  if (latencyMs < 1000) return `${Math.round(latencyMs)}ms`;
  return `${(latencyMs / 1000).toFixed(1)}s`;
}

/**
 * Canvas 2D + requestAnimationFrame renderer for the neuron graph. All live
 * state (nodes/firings) is read through refs so the rAF loop keeps running
 * without re-subscribing on every React render.
 *
 * Performance guards:
 *  - loop only runs while `running` is true (server up AND page visible);
 *  - when there are no active firings it renders one resting frame then idles
 *    (no continuous rAF churn) until new firings arrive;
 *  - `reducedMotion` collapses animation to a single static frame.
 */
export function NeuronCanvas({ nodes, synapses, firings, running, reducedMotion, onHoverNode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodesRef = useRef(nodes);
  const synapsesRef = useRef(synapses);
  const firingsRef = useRef(firings);
  const onHoverRef = useRef(onHoverNode);
  nodesRef.current = nodes;
  synapsesRef.current = synapses;
  firingsRef.current = firings;
  onHoverRef.current = onHoverNode;
  // Pointer offset (-1..1 on each axis, 0,0 = centered/resting) drives the
  // pseudo-3D parallax tilt. Eased toward the raw target each frame so the
  // scene glides rather than snaps.
  const tiltRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let disposed = false;

    function sizeCanvas() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas!.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      canvas!.width = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }

    let dims = sizeCanvas();
    const onResize = () => {
      dims = sizeCanvas();
      if (!running || reducedMotion) draw(performance.now(), true);
    };
    window.addEventListener("resize", onResize);

    // Pointer parallax. We only store the normalized target here; the eased
    // follow + redraw happen in the rAF loop. When the loop is idle (static
    // scene) a pointer move wakes it for a short settle, then it idles again
    // once the tilt has eased back or the pointer leaves.
    let settleUntil = 0;
    const wake = () => {
      settleUntil = performance.now() + 900;
      if (!raf && !disposed && running && !reducedMotion) raf = requestAnimationFrame(frame);
    };
    // Hit-test the pointer against node cores (in base layout space; the
    // parallax shift is small enough that a slightly padded radius still feels
    // right). Returns the closest node under the pointer, or null.
    let hoveredId: string | null = null;
    const hitTest = (localX: number, localY: number): NeuronNode | null => {
      const { w, h } = dims;
      const list = nodesRef.current;
      const maxReq = Math.max(1, ...list.map((n) => n.requests));
      let best: NeuronNode | null = null;
      let bestD = Infinity;
      for (const n of list) {
        const x = n.x * w;
        const y = n.y * h;
        const r = nodeRadius(n.requests, maxReq) + 6; // padding for easier hover
        const dx = localX - x;
        const dy = localY - y;
        const d = dx * dx + dy * dy;
        if (d <= r * r && d < bestD) {
          bestD = d;
          best = n;
        }
      }
      return best;
    };
    const emitHover = (e: PointerEvent, localX: number, localY: number) => {
      const cb = onHoverRef.current;
      if (!cb) return;
      const hit = hitTest(localX, localY);
      const id = hit?.id ?? null;
      if (id === hoveredId) return; // only fire on change
      hoveredId = id;
      cb(hit ? { node: hit, clientX: e.clientX, clientY: e.clientY } : null);
    };
    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas!.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      emitHover(e, localX, localY);
      if (reducedMotion || !running) return;
      const nx = localX / Math.max(1, rect.width);
      const ny = localY / Math.max(1, rect.height);
      tiltRef.current.tx = clamp((nx - 0.5) * 2, -1, 1);
      tiltRef.current.ty = clamp((ny - 0.5) * 2, -1, 1);
      wake();
    };
    const onPointerLeave = () => {
      if (hoveredId !== null) {
        hoveredId = null;
        onHoverRef.current?.(null);
      }
      tiltRef.current.tx = 0;
      tiltRef.current.ty = 0;
      wake();
    };
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);

    const posMap = () => {
      const m = new Map<string, NeuronNode>();
      for (const n of nodesRef.current) m.set(n.id, n);
      return m;
    };

    function draw(now: number, staticFrame: boolean) {
      const { w, h } = dims;
      const map = posMap();
      const list = nodesRef.current;
      const maxReq = Math.max(1, ...list.map((n) => n.requests));

      // Ease the tilt toward the pointer target (or back to rest on a static
      // frame). A larger node reads as "closer" and parallaxes more, giving a
      // sense of depth without any 3D library.
      const tilt = tiltRef.current;
      if (staticFrame) {
        tilt.x = 0;
        tilt.y = 0;
      } else {
        tilt.x += (tilt.tx - tilt.x) * 0.08;
        tilt.y += (tilt.ty - tilt.y) * 0.08;
      }
      const TILT_PX = 16; // max parallax shift of the closest node
      // Depth 0 (far, small node) barely moves; depth 1 (near, big node) moves
      // fully with the pointer. Returns the screen position for a node.
      const project = (nx: number, ny: number, depth: number) => ({
        x: nx * w + tilt.x * TILT_PX * depth,
        y: ny * h + tilt.y * TILT_PX * depth,
      });

      ctx!.clearRect(0, 0, w, h);

      // Subtle radial backdrop so glows read against the panel.
      const bg = ctx!.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h) / 1.4);
      bg.addColorStop(0, "rgba(255,255,255,0.02)");
      bg.addColorStop(1, "rgba(0,0,0,0)");
      ctx!.fillStyle = bg;
      ctx!.fillRect(0, 0, w, h);

      // The caller hub sits at the deepest layer, so it drifts least.
      const cx = 0.5 * w + tilt.x * TILT_PX * 0.15;
      const cy = 0.5 * h + tilt.y * TILT_PX * 0.15;

      // Time base for ambient motion. On a static frame everything freezes at a
      // fixed phase so the resting render is stable and reproducible.
      const t = staticFrame ? 0 : now / 1000;

      // Layer 1: slow rotating "aurora" glows behind everything, giving the
      // scene depth and gentle motion even when no model is firing. Two soft
      // radial blooms orbit the center in opposite directions.
      for (let i = 0; i < 2; i++) {
        const dir = i === 0 ? 1 : -1;
        const ang = dir * t * 0.06 + i * Math.PI;
        const orbit = Math.min(w, h) * 0.28;
        const ax = cx + Math.cos(ang) * orbit;
        const ay = cy + Math.sin(ang) * orbit * 0.7;
        const rad = Math.min(w, h) * 0.45;
        const tint = i === 0 ? "120,150,220" : "150,120,210";
        const aurora = ctx!.createRadialGradient(ax, ay, 0, ax, ay, rad);
        aurora.addColorStop(0, `rgba(${tint},0.05)`);
        aurora.addColorStop(1, `rgba(${tint},0)`);
        ctx!.fillStyle = aurora;
        ctx!.fillRect(0, 0, w, h);
      }

      // Layer 2: concentric "breathing" rings radiating from the hub, like a
      // faint radar sweep, so the empty space between neurons still feels
      // alive. Rings expand outward and fade; count kept small for cheapness.
      const ringBase = Math.min(w, h) * 0.5;
      for (let i = 0; i < 3; i++) {
        const phase = (t * 0.12 + i / 3) % 1;
        const rr = phase * ringBase;
        const alpha = 0.06 * (1 - phase);
        if (alpha <= 0.002) continue;
        ctx!.strokeStyle = `rgba(150,170,220,${alpha})`;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx!.stroke();
      }

      // Layer 3: a drifting dust field of faint particles. Positions are a
      // cheap deterministic function of index + time (no per-particle state
      // or allocation), so this is essentially free to render each frame.
      const DUST = 34;
      for (let i = 0; i < DUST; i++) {
        const seedX = Math.sin(i * 12.9898) * 43758.5453;
        const seedY = Math.sin(i * 78.233) * 12543.1234;
        const fx = seedX - Math.floor(seedX);
        const fy = seedY - Math.floor(seedY);
        // Drift slowly upward and wrap; horizontal sway via a slow sine.
        const speed = 0.008 + (fx * 0.012);
        const py = (fy - t * speed) % 1;
        const y = (py < 0 ? py + 1 : py) * h;
        const x = (fx * w + Math.sin(t * 0.3 + i) * 8) % w;
        const twinkle = 0.15 + 0.15 * (0.5 + 0.5 * Math.sin(t * 1.4 + i * 2.1));
        ctx!.fillStyle = `rgba(180,195,230,${staticFrame ? 0.12 : twinkle})`;
        ctx!.beginPath();
        ctx!.arc(x, y, 0.9, 0, Math.PI * 2);
        ctx!.fill();
      }

      // Synapses. A faint travelling highlight drifts outward along each line so
      // the resting graph reads as "wired and listening" rather than a dead
      // diagram. The drift is purely cosmetic and frozen on a static frame.
      ctx!.lineWidth = 1;
      const flow = staticFrame ? -1 : (now / 2600) % 1;
      for (const s of synapsesRef.current) {
        const to = map.get(s.to);
        if (!to) continue;
        const depth = 0.3 + 0.7 * (nodeRadius(to.requests, maxReq) - 5) / 13;
        const pos = project(to.x, to.y, depth);
        const tx = pos.x;
        const ty = pos.y;
        const c = colorFor(to.provider);
        // Base dim line.
        ctx!.strokeStyle = rgba(c, 0.08);
        ctx!.beginPath();
        ctx!.moveTo(cx, cy);
        ctx!.lineTo(tx, ty);
        ctx!.stroke();
        // Travelling highlight segment (skipped on static frames).
        if (flow >= 0) {
          const seg = 0.14;
          const a0 = clamp(flow - seg, 0, 1);
          const a1 = clamp(flow + seg, 0, 1);
          const grad = ctx!.createLinearGradient(cx, cy, tx, ty);
          grad.addColorStop(a0, rgba(c, 0));
          grad.addColorStop(flow, rgba(c, 0.16));
          grad.addColorStop(a1, rgba(c, 0));
          ctx!.strokeStyle = grad;
          ctx!.beginPath();
          ctx!.moveTo(cx, cy);
          ctx!.lineTo(tx, ty);
          ctx!.stroke();
        }
      }

      // Firing pulses travelling caller -> neuron.
      const active = firingsRef.current;
      let anyInFlight = false;
      for (const f of active) {
        // Staggered firings start in the future; keep them hidden until their
        // turn so a batch flows in as a sequence instead of a burst.
        if (!staticFrame && now < f.startedAt) continue;
        const to = map.get(f.nodeId);
        if (!to) continue;
        anyInFlight = true;
        const dur = pulseDuration(f.latencyMs);
        const p = staticFrame ? 1 : clamp((now - f.startedAt) / dur, 0, 1);
        const depth = 0.3 + 0.7 * (nodeRadius(to.requests, maxReq) - 5) / 13;
        const pos = project(to.x, to.y, depth);
        const tx = pos.x;
        const ty = pos.y;
        const px = cx + (tx - cx) * p;
        const py = cy + (ty - cy) * p;
        // Latency heat warms the pulse color: a slow response glows amber, a
        // fast one keeps its provider hue. Failures stay red.
        const heat = latencyHeat(f.latencyMs);
        const c = f.failed ? { r: 232, g: 80, b: 80 } : warmBlend(colorFor(to.provider), heat * 0.7);
        // Comet-style pulse: a brighter head with a soft glow.
        const headGlow = ctx!.createRadialGradient(px, py, 0, px, py, 7);
        headGlow.addColorStop(0, rgba(c, 0.8 * (1 - p) + 0.3));
        headGlow.addColorStop(1, rgba(c, 0));
        ctx!.fillStyle = headGlow;
        ctx!.beginPath();
        ctx!.arc(px, py, 7, 0, Math.PI * 2);
        ctx!.fill();
        ctx!.fillStyle = rgba(c, 0.9 * (1 - p) + 0.25);
        ctx!.beginPath();
        ctx!.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx!.fill();
        // Trailing line.
        ctx!.strokeStyle = rgba(c, 0.25 * (1 - p));
        ctx!.lineWidth = 1.5;
        ctx!.beginPath();
        ctx!.moveTo(cx, cy);
        ctx!.lineTo(px, py);
        ctx!.stroke();
        // Impact ripple: an expanding ring on the neuron as the pulse lands
        // (only in the pulse's final third), giving each real request a clear
        // "arrival" beat instead of a dot that just vanishes.
        if (!staticFrame && p > 0.66) {
          const land = (p - 0.66) / 0.34; // 0..1 over the arrival window
          const rr = 3 + land * (nodeRadius(to.requests, maxReq) + 10);
          ctx!.strokeStyle = rgba(c, 0.35 * (1 - land));
          ctx!.lineWidth = 1.5;
          ctx!.beginPath();
          ctx!.arc(tx, ty, rr, 0, Math.PI * 2);
          ctx!.stroke();
          // Label the real latency as the pulse arrives, but only for
          // responses slow enough to be worth noting, so we don't clutter the
          // graph with a number on every snappy request.
          if (f.latencyMs !== null && f.latencyMs >= 800) {
            ctx!.fillStyle = rgba(warmBlend({ r: 210, g: 210, b: 210 }, heat), 0.75 * (1 - land));
            ctx!.font = "10px var(--vscode-font-family, sans-serif)";
            ctx!.textAlign = "center";
            ctx!.fillText(latencyLabel(f.latencyMs), tx, ty - nodeRadius(to.requests, maxReq) - 6);
          }
        }
      }

      // Neurons.
      for (const n of list) {
        const r = nodeRadius(n.requests, maxReq);
        // Bigger node = "closer" layer = more parallax + a longer shadow.
        const depth = 0.3 + 0.7 * (r - 5) / 13;
        const pos = project(n.x, n.y, depth);
        const x = pos.x;
        const y = pos.y;
        const c = colorFor(n.provider);
        // Activation: recent hit brightens the node, decaying over time.
        let activation = 0;
        if (n.lastHitTs) {
          const age = Date.now() - n.lastHitTs;
          activation = clamp(1 - age / RESTING_DECAY_MS, 0, 1);
        }
        // Warm the node toward amber when its recent responses are slow, so
        // latency reads at a glance even between firings.
        const heat = activation > 0.05 ? latencyHeat(n.avgLatencyMs) : 0;
        // Resting breath so idle nodes still feel alive (skipped when static).
        const breath = staticFrame ? 0.5 : 0.5 + 0.5 * Math.sin(now / 900 + n.x * 7);
        const glowAlpha = 0.12 + activation * 0.5 + breath * 0.06;
        const dotColor =
          n.lastFailed && activation > 0.05 ? { r: 232, g: 80, b: 80 } : warmBlend(c, heat * 0.6);

        // Depth shadow: nodes cast a soft offset shadow away from the pointer,
        // reinforcing the parallax layering. Skipped for the flattest nodes.
        if (depth > 0.4) {
          const sx = x - tilt.x * TILT_PX * depth * 0.4;
          const sy = y - tilt.y * TILT_PX * depth * 0.4 + r * 0.5;
          const shadow = ctx!.createRadialGradient(sx, sy, 0, sx, sy, r * 1.6);
          shadow.addColorStop(0, `rgba(0,0,0,${0.18 * depth})`);
          shadow.addColorStop(1, "rgba(0,0,0,0)");
          ctx!.fillStyle = shadow;
          ctx!.beginPath();
          ctx!.arc(sx, sy, r * 1.6, 0, Math.PI * 2);
          ctx!.fill();
        }

        // Glow halo.
        const glow = ctx!.createRadialGradient(x, y, 0, x, y, r * 3.2);
        glow.addColorStop(0, rgba(dotColor, glowAlpha));
        glow.addColorStop(1, rgba(dotColor, 0));
        ctx!.fillStyle = glow;
        ctx!.beginPath();
        ctx!.arc(x, y, r * 3.2, 0, Math.PI * 2);
        ctx!.fill();

        // Core.
        ctx!.fillStyle = rgba(dotColor, 0.55 + activation * 0.4);
        ctx!.beginPath();
        ctx!.arc(x, y, r, 0, Math.PI * 2);
        ctx!.fill();
        // Crisp rim to define the node against its glow; brightens when active.
        ctx!.strokeStyle = rgba(dotColor, 0.35 + activation * 0.5);
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.arc(x, y, r, 0, Math.PI * 2);
        ctx!.stroke();
      }

      // Central caller hub. It breathes gently and glows brighter while any
      // pulse is in flight, so the "source" of activity is visually alive.
      const inFlight = anyInFlight;
      const hubBreath = staticFrame ? 0.5 : 0.5 + 0.5 * Math.sin(now / 700);
      const hubR = 4 + (inFlight ? 1.5 : 0) + hubBreath * 0.8;
      const hubGlow = ctx!.createRadialGradient(cx, cy, 0, cx, cy, hubR * 4);
      hubGlow.addColorStop(0, `rgba(255,255,255,${0.14 + (inFlight ? 0.12 : 0)})`);
      hubGlow.addColorStop(1, "rgba(255,255,255,0)");
      ctx!.fillStyle = hubGlow;
      ctx!.beginPath();
      ctx!.arc(cx, cy, hubR * 4, 0, Math.PI * 2);
      ctx!.fill();
      ctx!.fillStyle = "rgba(255,255,255,0.75)";
      ctx!.beginPath();
      ctx!.arc(cx, cy, hubR, 0, Math.PI * 2);
      ctx!.fill();
    }

    // Cap ambient (idle) rendering to ~24fps so the resting scene keeps its
    // gentle motion without burning a full 60fps of CPU on a static graph.
    // Foreground activity (firings, decaying nodes, parallax settle) always
    // runs at full frame rate for smoothness.
    const AMBIENT_MIN_INTERVAL = 1000 / 24;
    let lastAmbientDraw = 0;

    function frame() {
      if (disposed) return;
      const now = performance.now();
      const anyFiring = firingsRef.current.length > 0;
      const anyActive = nodesRef.current.some((n) => n.lastHitTs && Date.now() - n.lastHitTs < RESTING_DECAY_MS);
      const t = tiltRef.current;
      const tiltSettling = now < settleUntil || Math.abs(t.x - t.tx) > 0.002 || Math.abs(t.y - t.ty) > 0.002;
      const foreground = anyFiring || anyActive || tiltSettling;

      // Draw every frame when there's foreground activity; otherwise throttle
      // to the ambient rate so the aurora/dust/rings keep drifting cheaply.
      if (foreground || now - lastAmbientDraw >= AMBIENT_MIN_INTERVAL) {
        draw(now, false);
        lastAmbientDraw = now;
      }
      // Keep looping as long as the server is up and motion is allowed, so the
      // resting scene never freezes into a flat diagram. reducedMotion / server
      // stop fall through to a single static frame instead (see below).
      raf = requestAnimationFrame(frame);
    }

    if (reducedMotion || !running) {
      draw(performance.now(), true);
    } else {
      raf = requestAnimationFrame(frame);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
    };
    // Restart the loop whenever the firing set or running/motion flags change,
    // or the node set is rebuilt.
  }, [firings, running, reducedMotion, nodes]);

  return <canvas ref={canvasRef} className="neuron-canvas" />;
}
