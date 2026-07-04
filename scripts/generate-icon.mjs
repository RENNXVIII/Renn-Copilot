// Generates a few extension icon candidates (media/icon-*.png) -- a plain-JS
// PNG encoder (no image libraries) with a supersample+downsample pass for
// anti-aliasing. VS Code's marketplace icon must be a raster image (vsce
// rejects SVGs), and this is small enough not to warrant a native image
// dependency just for one icon. Pick a variant, then copy media/icon-<x>.png
// over media/icon.png and delete the rest.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "media");

const FINAL_SIZE = 256;
const SUPERSAMPLE = 4;
const SIZE = FINAL_SIZE * SUPERSAMPLE;

// Classic 5x7 LED-matrix-style bitmap glyphs for "R" and "C".
const GLYPHS = {
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
};

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function lerpColor(c1, c2, t) {
  return [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t))];
}

function letterMask() {
  const letters = ["R", "C"];
  const cols = 5 * letters.length + (letters.length - 1);
  const rows = 7;
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  letters.forEach((letter, li) => {
    const glyph = GLYPHS[letter];
    const colOffset = li * 6;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 5; c++) grid[r][colOffset + c] = glyph[r][c] === "1" ? 1 : 0;
    }
  });
  return { grid, cols, rows };
}

function isLetterPixel(x, y, scale) {
  const { grid, cols, rows } = letterMask();
  const gridWidth = cols * scale;
  const gridHeight = rows * scale;
  const marginX = Math.round((SIZE - gridWidth) / 2);
  const marginY = Math.round((SIZE - gridHeight) / 2);
  const gx = x - marginX;
  const gy = y - marginY;
  if (gx < 0 || gx >= gridWidth || gy < 0 || gy >= gridHeight) return false;
  return !!grid[Math.floor(gy / scale)][Math.floor(gx / scale)];
}

function roundedRectAlpha(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), SIZE - radius);
  const cy = Math.min(Math.max(y, radius), SIZE - radius);
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= radius - 1) return 1;
  if (dist >= radius + 1) return 0;
  return 1 - (dist - (radius - 1)) / 2;
}

function circleAlpha(x, y) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const r = SIZE / 2;
  const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
  if (dist <= r - 1) return 1;
  if (dist >= r + 1) return 0;
  return 1 - (dist - (r - 1)) / 2;
}

function smoothDiscAlpha(dist, r) {
  if (dist <= r - 1) return 1;
  if (dist >= r + 1) return 0;
  return 1 - (dist - (r - 1)) / 2;
}

function distToSegmentT(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return { dist: Math.sqrt((px - projX) ** 2 + (py - projY) ** 2), t };
}

// Geometric monoline "R" -- built from thick rounded-cap strokes (same
// technique as the hub-spoke connecting lines) instead of a tiny pixel font,
// so it stays crisp and legible after supersample-downsampling instead of
// turning into a blurry smudge at icon size.
const HUB_LETTER_COLOR = [30, 27, 75]; // indigo-950 -- reads as a cutout against the white hub
const R_SEGMENTS = [
  [0.08, 0.02, 0.08, 0.98], // stem
  [0.08, 0.02, 0.56, 0.02], // bowl top
  [0.56, 0.02, 0.56, 0.52], // bowl right
  [0.56, 0.52, 0.08, 0.52], // bowl bottom
  [0.3, 0.52, 0.62, 0.98], // diagonal leg
];

function hubLetterAlpha(x, y, cx, cy) {
  const height = HUB_R * 2 * 0.72;
  const width = height * 0.62;
  const originX = cx - width / 2;
  const originY = cy - height / 2;
  const thickness = height * 0.17;
  let best = 0;
  for (const [lx1, ly1, lx2, ly2] of R_SEGMENTS) {
    const { dist } = distToSegmentT(
      x,
      y,
      originX + lx1 * width,
      originY + ly1 * height,
      originX + lx2 * width,
      originY + ly2 * height
    );
    const a = smoothDiscAlpha(dist, thickness / 2);
    if (a > best) best = a;
  }
  return best;
}

// "Hub and spoke" mark: one central node (with a geometric "R" cut into it)
// and three satellite nodes connected by data-flow lines that fade from
// white (at the hub) to each satellite's own accent color -- reads as
// several AI providers (Gemini, Claude, GPT) relaying into one endpoint
// (Copilot Chat) rather than a literal "RC" monogram.
const HUB_R = SIZE * 0.17;
const SATELLITE_R = SIZE * 0.1;
const LINE_HALF_THICKNESS = SIZE * 0.016;
const ORBIT_R = SIZE * 0.33;
const SATELLITE_COLORS = [
  [56, 189, 248], // sky-400 -- electric blue
  [244, 114, 182], // pink-400 -- hot magenta
  [251, 191, 36], // amber-400 -- warm gold
];

function hubMarkPixel(x, y) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const satellites = [-90, 30, 150].map((deg, i) => {
    const rad = (deg * Math.PI) / 180;
    return { x: cx + Math.cos(rad) * ORBIT_R, y: cy + Math.sin(rad) * ORBIT_R, color: SATELLITE_COLORS[i] };
  });

  let bestAlpha = 0;
  let bestColor = WHITE;

  // Connecting "data flow" lines -- gradient from white near the hub to the
  // destination node's own color, suggesting motion/speed rather than a
  // flat static line.
  for (const sat of satellites) {
    const { dist, t } = distToSegmentT(x, y, cx, cy, sat.x, sat.y);
    const a = smoothDiscAlpha(dist, LINE_HALF_THICKNESS);
    if (a > bestAlpha) {
      bestAlpha = a;
      bestColor = lerpColor(WHITE, sat.color, Math.min(1, t * 1.3));
    }
  }

  // Satellite nodes.
  for (const sat of satellites) {
    const d = Math.sqrt((x - sat.x) ** 2 + (y - sat.y) ** 2);
    const a = smoothDiscAlpha(d, SATELLITE_R);
    if (a > bestAlpha) {
      bestAlpha = a;
      bestColor = sat.color;
    }
  }

  // Hub node (drawn last -- on top of everything), with a knocked-out "R".
  const dHub = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
  const aHub = smoothDiscAlpha(dHub, HUB_R);
  if (aHub > bestAlpha) {
    bestAlpha = aHub;
    bestColor = hubLetterAlpha(x, y, cx, cy) > 0.5 ? HUB_LETTER_COLOR : WHITE;
  }

  return { alpha: bestAlpha, color: bestColor };
}

/** Renders one SIZE x SIZE RGBA buffer for a given variant, then downsamples SUPERSAMPLE:1 with a box filter. */
function renderVariant(paintFn) {
  const hi = new Float64Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a] = paintFn(x, y);
      const i = (y * SIZE + x) * 4;
      hi[i] = r;
      hi[i + 1] = g;
      hi[i + 2] = b;
      hi[i + 3] = a;
    }
  }
  const out = new Uint8Array(FINAL_SIZE * FINAL_SIZE * 4);
  const n = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < FINAL_SIZE; y++) {
    for (let x = 0; x < FINAL_SIZE; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const hx = x * SUPERSAMPLE + sx;
          const hy = y * SUPERSAMPLE + sy;
          const i = (hy * SIZE + hx) * 4;
          r += hi[i];
          g += hi[i + 1];
          b += hi[i + 2];
          a += hi[i + 3];
        }
      }
      const o = (y * FINAL_SIZE + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(zlib.crc32(crcInput) >>> 0, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePngRgba(pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(FINAL_SIZE, 0);
  ihdrData.writeUInt32BE(FINAL_SIZE, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk("IHDR", ihdrData);

  const raw = Buffer.alloc(FINAL_SIZE * (1 + FINAL_SIZE * 4));
  for (let y = 0; y < FINAL_SIZE; y++) {
    const rowStart = y * (1 + FINAL_SIZE * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < FINAL_SIZE * 4; x++) {
      raw[rowStart + 1 + x] = pixels[y * FINAL_SIZE * 4 + x];
    }
  }
  const idat = chunk("IDAT", zlib.deflateSync(raw));
  const iend = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

// --- Variants -----------------------------------------------------------

const WHITE = [255, 255, 255];

// A: rounded square, vertical indigo->violet gradient, transparent corners.
function variantA(x, y) {
  const radius = SIZE * 0.16;
  const edgeAlpha = roundedRectAlpha(x, y, radius);
  const t = y / SIZE;
  const bg = lerpColor([55, 48, 163], [124, 58, 237], t); // indigo-700 -> violet-600
  const isLetter = isLetterPixel(x, y, 72);
  const color = isLetter ? WHITE : bg;
  return [...color, Math.round(edgeAlpha * 255)];
}

// B: circular badge, radial cyan gradient (lighter center), transparent outside circle.
function variantB(x, y) {
  const alpha = circleAlpha(x, y);
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const distFromCenter = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (SIZE / 2);
  const bg = lerpColor([56, 189, 248], [3, 105, 161], Math.min(1, distFromCenter)); // sky-400 -> sky-800
  const isLetter = isLetterPixel(x, y, 72);
  const color = isLetter ? WHITE : bg;
  return [...color, Math.round(alpha * 255)];
}

// C: diagonal two-tone split square, sharp corners, bold letters over the seam.
function variantC(x, y) {
  const diagT = (x + y) / (SIZE * 2);
  const bg = diagT < 0.5 ? [79, 70, 229] : [6, 182, 212]; // indigo-600 | cyan-500, hard split
  const isLetter = isLetterPixel(x, y, 72);
  const color = isLetter ? WHITE : bg;
  return [...color, 255];
}

// D: circular badge with a subtle orbit ring accent (proxy/relay motif) + letters.
function variantD(x, y) {
  const alpha = circleAlpha(x, y);
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
  const distFromCenter = dist / (SIZE / 2);
  const bg = lerpColor([88, 28, 135], [30, 27, 75], Math.min(1, distFromCenter)); // purple-900 -> indigo-950
  const ringR1 = SIZE * 0.42;
  const ringR2 = SIZE * 0.46;
  const onRing = dist >= ringR1 && dist <= ringR2;
  const isLetter = isLetterPixel(x, y, 72);
  let color = bg;
  if (onRing) color = lerpColor(bg, [217, 70, 239], 0.85); // fuchsia-500 accent ring
  if (isLetter) color = WHITE;
  return [...color, Math.round(alpha * 255)];
}

// E: rounded square, indigo->violet gradient, hub-and-spoke mark (no letters).
function variantE(x, y) {
  const radius = SIZE * 0.16;
  const edgeAlpha = roundedRectAlpha(x, y, radius);
  const t = y / SIZE;
  const bg = lerpColor([55, 48, 163], [124, 58, 237], t); // indigo-700 -> violet-600
  const mark = hubMarkPixel(x, y);
  const color = lerpColor(bg, mark.color, mark.alpha);
  return [...color, Math.round(edgeAlpha * 255)];
}

// F: circular badge, diagonal violet->magenta "AI energy" gradient with a
// thin glowing halo ring near the edge, hub-and-spoke mark with the R glyph.
function variantF(x, y) {
  const alpha = circleAlpha(x, y);
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const r = SIZE / 2;
  const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

  // Diagonal gradient (top-left to bottom-right) reads more dynamic/"fast"
  // than a plain vertical or radial one.
  const diagT = (x + y) / (SIZE * 2);
  let bg = lerpColor([49, 33, 120], [190, 24, 93], diagT); // deep indigo -> vivid magenta/rose

  // Thin bright halo ring near the outer edge -- a small "futuristic tech"
  // signature without adding visual noise to the center mark.
  const ringR1 = r * 0.86;
  const ringR2 = r * 0.92;
  if (dist >= ringR1 && dist <= ringR2) {
    const ringT = (dist - ringR1) / (ringR2 - ringR1);
    const glow = 1 - Math.abs(ringT - 0.5) * 2; // brightest at the ring's midline
    bg = lerpColor(bg, [244, 214, 255], glow * 0.55);
  }

  const mark = hubMarkPixel(x, y);
  const color = lerpColor(bg, mark.color, mark.alpha);
  return [...color, Math.round(alpha * 255)];
}

// --- Flat geometric "pinwheel relay" mark --------------------------------
// Three kite-shaped petals (120 degrees apart) forming a triangular pinwheel,
// with an explicit circular cutout at the center -- flat single color, no
// gradients/glow, in the spirit of minimalist geometric extension icons
// (interlocking-shape marks with visible negative space in the middle).
function sign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const PETAL_OUTER = SIZE * 0.36;
const PETAL_MID_T = 0.56; // where the kite is widest, as a fraction of outer radius
const PETAL_HALF_WIDTH = SIZE * 0.108;
const PETAL_INNER = SIZE * 0.05; // near-center taper point, not the true center
const PETAL_HOLE_R = SIZE * 0.09; // explicit negative-space cutout at the very center

function pinwheelAlpha(x, y) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const dCenter = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
  if (dCenter < PETAL_HOLE_R) return 0;

  for (const deg of [-90, 30, 150]) {
    const rad = (deg * Math.PI) / 180;
    const fx = Math.cos(rad); // forward unit vector
    const fy = Math.sin(rad);
    const sx = -fy; // perpendicular (side) unit vector
    const sy = fx;

    const innerX = cx + fx * PETAL_INNER;
    const innerY = cy + fy * PETAL_INNER;
    const midX = cx + fx * PETAL_OUTER * PETAL_MID_T;
    const midY = cy + fy * PETAL_OUTER * PETAL_MID_T;
    const tipX = cx + fx * PETAL_OUTER;
    const tipY = cy + fy * PETAL_OUTER;
    const leftX = midX + sx * PETAL_HALF_WIDTH;
    const leftY = midY + sy * PETAL_HALF_WIDTH;
    const rightX = midX - sx * PETAL_HALF_WIDTH;
    const rightY = midY - sy * PETAL_HALF_WIDTH;

    if (
      pointInTriangle(x, y, innerX, innerY, leftX, leftY, tipX, tipY) ||
      pointInTriangle(x, y, innerX, innerY, rightX, rightY, tipX, tipY)
    ) {
      return 1;
    }
  }
  return 0;
}

// G: flat two-tone circle -- solid cream background, solid charcoal-navy
// pinwheel mark, no gradients/glow (matches a plain minimalist geometric
// mark style rather than the AI-gradient variants above).
const FLAT_BG = [244, 240, 232]; // warm off-white
const FLAT_FG = [30, 28, 46]; // near-black charcoal-navy
function variantG(x, y) {
  const alpha = circleAlpha(x, y);
  const isMark = pinwheelAlpha(x, y) > 0;
  const color = isMark ? FLAT_FG : FLAT_BG;
  return [...color, Math.round(alpha * 255)];
}

// H: inverted flat palette -- solid charcoal-navy background, cream mark.
function variantH(x, y) {
  const alpha = circleAlpha(x, y);
  const isMark = pinwheelAlpha(x, y) > 0;
  const color = isMark ? FLAT_BG : FLAT_FG;
  return [...color, Math.round(alpha * 255)];
}

// --- Interlocking rings mark ----------------------------------------------
// Three ring (annulus) shapes arranged in a triangle, each overlapping its
// neighbors. Because each ring has a see-through hole, wherever one ring's
// band crosses another ring's hole it naturally reads as passing "through"
// it -- the classic interlocking-rings illusion (Olympic-rings-style),
// with zero gap-cutting/z-order math needed. Also leaves a clean negative-
// space opening at the icon's true center, similar to the reference logo.
const RING_ORBIT = SIZE * 0.11;
const RING_OUTER = SIZE * 0.2;
const RING_INNER = SIZE * 0.13;

function ringsAlpha(x, y) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  for (const deg of [-90, 30, 150]) {
    const rad = (deg * Math.PI) / 180;
    const rcx = cx + Math.cos(rad) * RING_ORBIT;
    const rcy = cy + Math.sin(rad) * RING_ORBIT;
    const d = Math.sqrt((x - rcx) ** 2 + (y - rcy) ** 2);
    if (d >= RING_INNER && d <= RING_OUTER) return 1;
  }
  return 0;
}

// I: flat cream circle, interlocking-rings mark in charcoal-navy.
function variantI(x, y) {
  const alpha = circleAlpha(x, y);
  const isMark = ringsAlpha(x, y) > 0;
  const color = isMark ? FLAT_FG : FLAT_BG;
  return [...color, Math.round(alpha * 255)];
}

// J: flat charcoal-navy circle, interlocking-rings mark in cream (matches the reference's dark-mark-on-light more closely inverted).
function variantJ(x, y) {
  const alpha = circleAlpha(x, y);
  const isMark = ringsAlpha(x, y) > 0;
  const color = isMark ? FLAT_BG : FLAT_FG;
  return [...color, Math.round(alpha * 255)];
}

const variants = { g: variantG, h: variantH, i: variantI, j: variantJ };

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, fn] of Object.entries(variants)) {
  const pixels = renderVariant(fn);
  const png = encodePngRgba(pixels);
  const outPath = path.join(OUT_DIR, `icon-${name}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Wrote ${outPath} (${png.length} bytes)`);
}
