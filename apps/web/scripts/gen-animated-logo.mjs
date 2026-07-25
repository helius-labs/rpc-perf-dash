/**
 * gen-animated-logo.mjs — generate a provider's animated "dot animation" winner
 * logo (public/logos/animated/<id>.html) from its static SVG.
 *
 * The overview page renders the #1 provider's logo as an animated dot grid
 * (see OverviewBoard `HeroLogo` + `ANIMATED_LOGOS` in src/lib/providerColors.ts).
 * Each HTML bakes a precomputed dot array sampled from the SVG — you can't just
 * swap the source SVG. When you add a provider you must generate this file AND
 * add its `ANIMATED_LOGOS` entry, or a provider ranking #1 shows no animation.
 *
 * The dot-animation technique + the original konvert.design tool are by
 * @hewarsaber (https://x.com/hewarsaber). This script is a faithful port of that
 * tool's sampler (validated to ~1 dot / 1246 against its own reference output):
 * rasterize the SVG aspect-preserved on a 512² transparent canvas; for each cell
 * of a density×density grid emit a dot where nearest-pixel alpha ≥ 0.5, sized by
 * `0.45 + (1 - min(1, 1.4*h))*0.7` where h = Sobel edge magnitude on alpha
 * (interior → 1.15, hard edge → 0.45), colored by the nearest source pixel.
 *
 * Params are fixed to the repo convention (density 50, dotSize 2.6, diagonal,
 * speed 0.4, wavelength 0.3, sharpness 0.4, restOpacity 0.33, variable size on,
 * edge boost off, sample-from-source on). An existing animated HTML is used as
 * the output template so the (transparent, clearRect) export wrapper matches;
 * only the `data` blob and <title> are swapped.
 *
 * Usage:
 *   pnpm gen:animated-logo <input.svg> <output.html> [--title "name.svg"]
 *   # e.g.
 *   pnpm gen:animated-logo \
 *     apps/web/public/logos/chainstack.svg \
 *     apps/web/public/logos/animated/chainstack.html
 *
 * Then add `<id>: "/logos/animated/<id>.html"` to ANIMATED_LOGOS.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const args = process.argv.slice(2);
const svgPath = args[0];
const outPath = args[1];
if (!svgPath || !outPath) {
  console.error("usage: pnpm gen:animated-logo <input.svg> <output.html> [--title <name.svg>]");
  process.exit(2);
}
const titleFlag = args.indexOf("--title");
const titleName = titleFlag >= 0 ? args[titleFlag + 1] : svgPath.split("/").pop();

// Default template: an existing animated logo in the same output directory.
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE = resolve(HERE, "../public/logos/animated/triton.html");
const templatePath = process.env.TEMPLATE ?? DEFAULT_TEMPLATE;

const SIZE = 512;
const DENSITY = 50;
const VARIABLE_SIZE = true;
const EDGE_BOOST = false; // second (1.7× denser) pass — intentionally off for our logos
const SAMPLE_FROM_SOURCE = true;

const { data: D } = await sharp(readFileSync(svgPath), { density: 900 })
  .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const W = SIZE;
const b = (t, l) => {
  const o = Math.max(0, Math.min(W - 1, Math.round(t)));
  const y = Math.max(0, Math.min(W - 1, Math.round(l)));
  return D[(y * W + o) * 4 + 3] / 255;
};
const edge = (t, l) => {
  const o = b(t - 1, l - 1), r = b(t, l - 1), n = b(t + 1, l - 1);
  const i = b(t - 1, l), s = b(t + 1, l);
  const d = b(t - 1, l + 1), c = b(t, l + 1), u = b(t + 1, l + 1);
  const gx = -o + n - 2 * i + 2 * s - d + u;
  const gy = -o - 2 * r - n + d + 2 * c + u;
  return Math.min(1, Math.sqrt(gx * gx + gy * gy) / 4);
};
const color = (t, l) => {
  if (!SAMPLE_FROM_SOURCE) return [0, 0, 0];
  const o = Math.max(0, Math.min(W - 1, Math.round(t)));
  const y = Math.max(0, Math.min(W - 1, Math.round(l)));
  const p = (y * W + o) * 4;
  return [D[p], D[p + 1], D[p + 2]];
};
const round = (v, d) => { const f = 10 ** d; return Math.round(v * f) / f; };

const dots = [];
const cell = W / DENSITY;
for (let e = 0; e < DENSITY; e++) {
  for (let o = 0; o < DENSITY; o++) {
    const u = (o + 0.5) * cell, m = (e + 0.5) * cell;
    if (b(u, m) < 0.5) continue;
    const h = VARIABLE_SIZE || EDGE_BOOST ? edge(u, m) : 0;
    const s = VARIABLE_SIZE ? 0.45 + (1 - Math.min(1, 1.4 * h)) * 0.7 : 1;
    const c = color(u, m);
    dots.push({
      x: round(u / W, 2), y: round(m / W, 2), s: round(s, 3),
      c: [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])],
    });
  }
}

const params = {
  dotSize: 2.6, dotShape: "circle", animMode: "diagonal",
  speed: 0.4, wavelength: 0.3, sharpness: 0.4, restOpacity: 0.33,
  color: "#ffffff", background: "#12171a", sampleFromSource: true,
};
const dataJson = JSON.stringify({ dots, params });

// Function replacements so `$` sequences in the payload aren't treated as regex
// backreferences ($&, $1, …). JSON emits no bare `$`, but this is injection-proof.
let html = readFileSync(templatePath, "utf8");
html = html.replace(/var data = \{.*?\};/s, () => `var data = ${dataJson};`);
html = html.replace(/<title>.*?<\/title>/s, () => `<title>${titleName} — dot animation</title>`);
writeFileSync(outPath, html);

const atCap = dots.filter((d) => d.s === 1.15).length;
console.log(
  `[gen-animated-logo] wrote ${outPath}: ${dots.length} dots ` +
    `(${Math.round((100 * atCap) / dots.length)}% at cap) from ${svgPath}`,
);
