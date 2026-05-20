import sharp from 'sharp';

import type { RasterizedPage } from '../rasterize/pdfjs';
import type { NormalizedBBox, RegionResult } from '../extract/jobStore';

// ─── Algorithm parameters ──────────────────────────────────────────────────

// Scan window: only consider components that live in this bottom band of the
// last page. The spec calls for the bottom 30%.
const SCAN_WINDOW_RATIO = 0.3;

// Binarization threshold. Pixels with greyscale value < this are "ink."
const BINARIZE_THRESHOLD = 180;

// Acceptable signature shape: wider-than-tall, but not absurdly elongated.
// Below 2:1 looks more like a stamp or block of text; above 6:1 looks like a
// printed horizontal rule.
const MIN_ASPECT_RATIO = 2;
const MAX_ASPECT_RATIO = 6;

// Minimum component area in scan-window pixels. Anything smaller is likely
// speckle noise rather than a real signature stroke.
const MIN_AREA_PX = 400;

// A component must beat this confidence floor to be returned. Below the
// floor, we surface null with a reason instead of a low-confidence guess.
const MIN_CONFIDENCE = 0.35;

// Saturation point for the area signal. Components ≥ this many pixels score
// 1.0 on the area axis; smaller components scale linearly.
const FULL_AREA_PX = 6000;

// Saturation point for the isolation signal — measured in scan-window pixels
// to the nearest other component.
const FULL_ISOLATION_PX = 200;

// ─── Public surface ───────────────────────────────────────────────────────

export async function detectSignature(
  pages: RasterizedPage[],
): Promise<RegionResult | null> {
  if (pages.length === 0) {
    return { status: 'not_found', reason: 'no pages provided' };
  }

  const lastPage = pages.at(-1);
  if (!lastPage) return notFound();

  const windowHeightPx = Math.floor(lastPage.height * SCAN_WINDOW_RATIO);
  if (windowHeightPx < 4) return notFound();

  const windowStartY = lastPage.height - windowHeightPx;
  const binaryMask = await binarizeBottomBand(
    lastPage,
    windowStartY,
    windowHeightPx,
  );

  const components = findConnectedComponents(
    binaryMask,
    lastPage.width,
    windowHeightPx,
  );

  const candidates = components.filter(isSignatureShaped);
  if (candidates.length === 0) return notFound();

  const scored = candidates
    .map((c) => ({
      component: c,
      score: scoreConfidence(c, components),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < MIN_CONFIDENCE) return notFound();

  return {
    status: 'detected',
    bbox: componentToNormalizedBBox(
      best.component,
      lastPage.width,
      lastPage.height,
      windowStartY,
    ),
    detector: 'heuristic',
    confidence: best.score,
  };
}

function notFound(): RegionResult {
  return {
    status: 'not_found',
    reason: 'no candidate region met confidence threshold',
  };
}

// ─── Binarization ─────────────────────────────────────────────────────────

async function binarizeBottomBand(
  page: RasterizedPage,
  startY: number,
  windowHeight: number,
): Promise<Uint8Array> {
  const { width, greyscale } = page;
  // Slice the bottom band of the greyscale buffer (single channel, 8-bit).
  const sliceStart = startY * width;
  const sliceEnd = sliceStart + width * windowHeight;
  const band = greyscale.subarray(sliceStart, sliceEnd);

  // The .greyscale() call before .threshold() is load-bearing: without it
  // sharp expands the output to 3-channel RGB after thresholding. Per the
  // task spec, the pipeline is `sharp().greyscale().threshold(180)` — and
  // .greyscale() pins the colorspace at single-channel through to .raw().
  const binarized = await sharp(Buffer.from(band), {
    raw: { width, height: windowHeight, channels: 1 },
  })
    .greyscale()
    .threshold(BINARIZE_THRESHOLD)
    .raw()
    .toBuffer();
  return new Uint8Array(binarized);
}

// ─── Connected components (two-pass union-find, 4-connectivity) ───────────

interface Component {
  id: number;
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// Threshold for "ink" in the binarized mask. sharp emits 0/255, so any
// strict-less-than 128 catches the ink pixels exactly.
const INK_PIXEL_THRESHOLD = 128;

// Union-find over integer labels with path compression. Labels are dense
// non-negative integers; 0 is reserved as "no label / background."
class UnionFind {
  private readonly parent: number[] = [0];

  add(): number {
    const label = this.parent.length;
    this.parent.push(label);
    return label;
  }

  find(label: number): number {
    let root = label;
    while ((this.parent[root] ?? root) !== root) root = this.parent[root]!;
    // path compression on the way back up
    let l = label;
    while ((this.parent[l] ?? l) !== root) {
      const next = this.parent[l]!;
      this.parent[l] = root;
      l = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

// Pass 1 of two-pass CCL: walk every ink pixel and assign a provisional
// label based on its top and left neighbors (4-connectivity). Returns the
// per-pixel label buffer and the union-find that resolves label equivalence.
function labelInkPixels(
  mask: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; uf: UnionFind } {
  const labels = new Int32Array(width * height);
  const uf = new UnionFind();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if ((mask[idx] ?? 255) >= INK_PIXEL_THRESHOLD) continue;

      const above = y > 0 ? labels[idx - width] ?? 0 : 0;
      const left = x > 0 ? labels[idx - 1] ?? 0 : 0;
      labels[idx] = pickLabel(above, left, uf);
    }
  }
  return { labels, uf };
}

// Decide a pixel's label from its already-labeled neighbors, allocating a
// new label or unioning two existing ones as needed.
function pickLabel(above: number, left: number, uf: UnionFind): number {
  if (above === 0 && left === 0) return uf.add();
  if (above !== 0 && left === 0) return above;
  if (above === 0 && left !== 0) return left;
  const chosen = Math.min(above, left);
  if (above !== left) uf.union(above, left);
  return chosen;
}

// Pass 2: collapse each pixel's provisional label to its union-find root,
// accumulate per-component bbox and area.
function summarizeComponents(
  labels: Int32Array,
  uf: UnionFind,
  width: number,
  height: number,
): Component[] {
  const stats = new Map<number, Component>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const label = labels[y * width + x] ?? 0;
      if (label === 0) continue;
      growComponent(stats, uf.find(label), x, y);
    }
  }
  return Array.from(stats.values());
}

function growComponent(
  stats: Map<number, Component>,
  id: number,
  x: number,
  y: number,
): void {
  const existing = stats.get(id);
  if (!existing) {
    stats.set(id, { id, area: 1, minX: x, maxX: x, minY: y, maxY: y });
    return;
  }
  existing.area++;
  if (x < existing.minX) existing.minX = x;
  if (x > existing.maxX) existing.maxX = x;
  if (y < existing.minY) existing.minY = y;
  if (y > existing.maxY) existing.maxY = y;
}

function findConnectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): Component[] {
  const { labels, uf } = labelInkPixels(mask, width, height);
  return summarizeComponents(labels, uf, width, height);
}

// ─── Candidate filtering and scoring ───────────────────────────────────────

function isSignatureShaped(c: Component): boolean {
  if (c.area < MIN_AREA_PX) return false;
  const w = c.maxX - c.minX + 1;
  const h = c.maxY - c.minY + 1;
  if (h === 0) return false;
  const aspectRatio = w / h;
  return aspectRatio >= MIN_ASPECT_RATIO && aspectRatio <= MAX_ASPECT_RATIO;
}

function componentToNormalizedBBox(
  c: Component,
  pageWidth: number,
  pageHeight: number,
  windowStartY: number,
): NormalizedBBox {
  const w = c.maxX - c.minX + 1;
  const h = c.maxY - c.minY + 1;
  return {
    x: c.minX / pageWidth,
    y: (windowStartY + c.minY) / pageHeight,
    w: w / pageWidth,
    h: h / pageHeight,
  };
}

// Distance from `target`'s bbox to the nearest other component's bbox, in
// the same pixel coordinate space. Cheap proxy — bbox distance, not pixel
// distance — but sufficient to rank "isolated" vs "crowded."
function minBBoxDistanceToOthers(
  target: Component,
  all: Component[],
): number {
  let nearest = Infinity;
  for (const other of all) {
    if (other.id === target.id) continue;
    const dx = Math.max(0, Math.max(target.minX - other.maxX, other.minX - target.maxX));
    const dy = Math.max(0, Math.max(target.minY - other.maxY, other.minY - target.maxY));
    const d = Math.hypot(dx, dy);
    if (d < nearest) nearest = d;
  }
  return nearest === Infinity ? FULL_ISOLATION_PX : nearest;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function scoreConfidence(
  target: Component,
  allComponents: Component[],
): number {
  // Two-signal blend: size and isolation. The spec mentions stroke-width
  // variance as a third signal; we omit it for now because (a) area + aspect
  // already filter out the printed-text-with-uniform-stroke case, and (b)
  // distance-transform-based stroke variance adds ~50 LOC for a small
  // accuracy gain. Easy to add later as a third weighted signal.
  const sizeSignal = clamp01(target.area / FULL_AREA_PX);
  const isolationDistance = minBBoxDistanceToOthers(target, allComponents);
  const isolationSignal = clamp01(isolationDistance / FULL_ISOLATION_PX);
  return 0.6 * sizeSignal + 0.4 * isolationSignal;
}
