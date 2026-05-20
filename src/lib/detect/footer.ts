import type { RasterizedPage } from '../rasterize/pdfjs';
import type { RegionResult } from '../extract/jobStore';

type DetectedRegion = Extract<RegionResult, { status: 'detected' }>;

export type FooterMode = 'default' | 'smart';

export interface FooterOptions {
  mode?: FooterMode;
}

// Heuristic priors mirror those in lib/detect/letterhead.ts, with the y-axis
// inverted: the footer lives at the bottom of the page, so we scan upward
// from the bottom edge instead of downward from the top.
const DEFAULT_CROP_H_RATIO = 0.12;
const DEFAULT_MODE_CONFIDENCE = 0.5;

const SCAN_WINDOW_RATIO = 0.35;       // scan the bottom 35% of the page
const BINARIZE_THRESHOLD = 180;
const MIN_INK_DENSITY_RATIO = 0.1;
const MIN_CONSECUTIVE_INK_ROWS = 3;
const WHITE_ROW_THRESHOLD = 0.8;

// The boundary must sit at least this far from the bottom edge — otherwise
// it's likely a noisy last-row artifact rather than a real footer top edge.
const MIN_BOUNDARY_FROM_BOTTOM_RATIO = 0.05;

const MIN_SMART_CONFIDENCE = 0.5;
const FULL_INK_DENSITY_RATIO = 0.3;
const WHITE_ROW_NORMALIZATION_RANGE = 1 - WHITE_ROW_THRESHOLD;

// For the multi-page "same region appears on N pages" check, two pages
// share the same footer when their per-row ink densities in the footer
// bbox correlate strongly. The threshold is loose because real-world
// docs (e.g., NYSCEF court filings) have body text that bleeds into the
// upper portion of the detected footer region but a recurring page-
// number band in the bottom strip. A tighter threshold misses those
// genuine recurrences; the cost of a looser threshold is the occasional
// false-positive "appears on N pages" note, which the UI surfaces but
// the user can ignore.
const FOOTPRINT_MATCH_THRESHOLD = 0.7;

export async function detectFooter(
  pages: RasterizedPage[],
  opts: FooterOptions = {},
): Promise<RegionResult | null> {
  if (pages.length === 0) {
    return { status: 'not_found', reason: 'no pages provided' };
  }

  const lastPage = pages.at(-1);
  if (!lastPage) return defaultCrop();

  const mode = opts.mode ?? 'default';
  if (mode === 'default') {
    return defaultCrop();
  }

  const smart = smartScan(lastPage);
  const result = smart ?? defaultCrop();

  // Multi-page note: only meaningful when there's more than one page AND
  // the same footer footprint appears on every other page. Compare the
  // per-page ink layout within the bbox we just chose — body content above
  // the footer band varies page to page even when the footer itself
  // doesn't, so a full-window comparison would miss recurring footers.
  //
  // TODO: when the bbox is large (smart-scan picked a high boundary because
  // there's a clean gap above the footer), the comparison currently spans
  // body content that varies page to page. Tightening to a fixed bottom-
  // strip window (e.g. the bottom 8% of the page) would let us tighten the
  // FOOTPRINT_MATCH_THRESHOLD back to ~0.85 without losing real recurrences.
  if (pages.length > 1) {
    const otherPages = pages.slice(0, -1);
    const matchedOthers = countMatchingFootprints(
      otherPages,
      lastPage,
      result.bbox,
    );
    if (matchedOthers === otherPages.length) {
      return {
        ...result,
        note: `Same region appears on all ${pages.length} pages.`,
      };
    }
  }

  return result;
}

function defaultCrop(): DetectedRegion {
  return {
    status: 'detected',
    bbox: { x: 0, y: 1 - DEFAULT_CROP_H_RATIO, w: 1, h: DEFAULT_CROP_H_RATIO },
    detector: 'heuristic',
    confidence: DEFAULT_MODE_CONFIDENCE,
  };
}

interface RowStats {
  inkRatio: number;
}

function computeBottomRowStats(page: RasterizedPage): {
  rows: RowStats[];
  windowStartY: number;
} {
  // Walk the bottom SCAN_WINDOW_RATIO of the page from the bottom up.
  // rows[0] is the bottom-most row; rows[len-1] is the top of the window.
  const { width, height, greyscale } = page;
  const windowHeight = Math.floor(height * SCAN_WINDOW_RATIO);
  const windowStartY = height - windowHeight;
  const rows: RowStats[] = new Array<RowStats>(windowHeight);
  for (let i = 0; i < windowHeight; i++) {
    const y = height - 1 - i;
    let inkCount = 0;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      if ((greyscale[rowStart + x] ?? 255) < BINARIZE_THRESHOLD) inkCount++;
    }
    rows[i] = { inkRatio: inkCount / width };
  }
  return { rows, windowStartY };
}

function findFirstInkBand(rows: RowStats[]): number | null {
  for (let i = 0; i <= rows.length - MIN_CONSECUTIVE_INK_ROWS; i++) {
    let allInky = true;
    for (let k = 0; k < MIN_CONSECUTIVE_INK_ROWS; k++) {
      if ((rows[i + k]?.inkRatio ?? 0) < MIN_INK_DENSITY_RATIO) {
        allInky = false;
        break;
      }
    }
    if (allInky) return i;
  }
  return null;
}

function findFirstWhiteRow(rows: RowStats[], from: number): number | null {
  for (let i = from; i < rows.length; i++) {
    const inkRatio = rows[i]?.inkRatio ?? 0;
    if (1 - inkRatio >= WHITE_ROW_THRESHOLD) return i;
  }
  return null;
}

function bandInkDensity(
  rows: RowStats[],
  bandStart: number,
  bandEnd: number,
): number {
  let sum = 0;
  for (let i = bandStart; i < bandEnd; i++) sum += rows[i]?.inkRatio ?? 0;
  const len = bandEnd - bandStart;
  return len > 0 ? sum / len : 0;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function scoreConfidence(
  bandDensity: number,
  whiteRowInkRatio: number,
  boundaryDepthFromBottom: number,
): number {
  // Same three signals as the letterhead detector, mirrored to bottom-up.
  // "depth" here is how far the boundary sits ABOVE the bottom edge — too
  // shallow is suspicious, the default-zone depth is most credible.
  const inkDensitySignal = clamp01(bandDensity / FULL_INK_DENSITY_RATIO);
  const whitenessSignal = clamp01(
    (1 - whiteRowInkRatio - WHITE_ROW_THRESHOLD) /
      WHITE_ROW_NORMALIZATION_RANGE,
  );

  // The upper bound (> SCAN_WINDOW_RATIO) is unreachable: boundary indices
  // come from the scan window itself, whose width is bounded by
  // SCAN_WINDOW_RATIO. The lower bound is what does real work — boundaries
  // less than MIN_BOUNDARY_FROM_BOTTOM_RATIO are rejected before this call,
  // but if any future caller bypasses that gate the depth signal collapses
  // to zero, which is the correct behavior.
  let depthSignal: number;
  if (boundaryDepthFromBottom < MIN_BOUNDARY_FROM_BOTTOM_RATIO) {
    depthSignal = 0;
  } else if (boundaryDepthFromBottom < DEFAULT_CROP_H_RATIO) {
    depthSignal =
      (boundaryDepthFromBottom - MIN_BOUNDARY_FROM_BOTTOM_RATIO) /
      (DEFAULT_CROP_H_RATIO - MIN_BOUNDARY_FROM_BOTTOM_RATIO);
  } else {
    depthSignal = 1;
  }

  return 0.25 * inkDensitySignal + 0.35 * whitenessSignal + 0.4 * depthSignal;
}

function smartScan(page: RasterizedPage): DetectedRegion | null {
  const { rows } = computeBottomRowStats(page);
  if (rows.length < MIN_CONSECUTIVE_INK_ROWS + 1) return null;

  const bandStartFromBottom = findFirstInkBand(rows);
  if (bandStartFromBottom === null) return null;

  const boundaryFromBottom = findFirstWhiteRow(
    rows,
    bandStartFromBottom + MIN_CONSECUTIVE_INK_ROWS,
  );
  if (boundaryFromBottom === null) return null;

  // Convert "rows from bottom" → absolute y in [0, 1].
  const boundaryDepthFromBottom = boundaryFromBottom / page.height;
  if (boundaryDepthFromBottom < MIN_BOUNDARY_FROM_BOTTOM_RATIO) return null;

  const bandDensity = bandInkDensity(
    rows,
    bandStartFromBottom,
    boundaryFromBottom,
  );
  const whiteRowInkRatio = rows[boundaryFromBottom]?.inkRatio ?? 0;
  const confidence = scoreConfidence(
    bandDensity,
    whiteRowInkRatio,
    boundaryDepthFromBottom,
  );
  if (confidence < MIN_SMART_CONFIDENCE) return null;

  // The bbox spans from the boundary down to the bottom of the page.
  const yRatio = 1 - boundaryDepthFromBottom;
  return {
    status: 'detected',
    bbox: { x: 0, y: yRatio, w: 1, h: boundaryDepthFromBottom },
    detector: 'heuristic',
    confidence,
  };
}

// Compute per-row ink ratios within a normalized bbox window on a page.
// Used by the multi-page comparison to ignore body content above the footer.
function computeRowStatsInBBox(
  page: RasterizedPage,
  bbox: { x: number; y: number; w: number; h: number },
): RowStats[] {
  const { width, height, greyscale } = page;
  const startY = Math.floor(bbox.y * height);
  const endY = Math.min(height, Math.floor((bbox.y + bbox.h) * height));
  const rows: RowStats[] = [];
  for (let y = startY; y < endY; y++) {
    let inkCount = 0;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      if ((greyscale[rowStart + x] ?? 255) < BINARIZE_THRESHOLD) inkCount++;
    }
    rows.push({ inkRatio: inkCount / width });
  }
  return rows;
}

// Page-to-page footprint comparison restricted to a bbox region. Two pages
// whose ink layout in that region matches closely score near 1; unrelated
// pages score near 0.
function footprintSimilarity(
  a: RasterizedPage,
  b: RasterizedPage,
  bbox: { x: number; y: number; w: number; h: number },
): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  const rowsA = computeRowStatsInBBox(a, bbox);
  const rowsB = computeRowStatsInBBox(b, bbox);
  if (rowsA.length !== rowsB.length || rowsA.length === 0) return 0;

  let totalDiff = 0;
  for (let i = 0; i < rowsA.length; i++) {
    const da = rowsA[i]?.inkRatio ?? 0;
    const db = rowsB[i]?.inkRatio ?? 0;
    totalDiff += Math.abs(da - db);
  }
  const meanDiff = totalDiff / rowsA.length;
  return clamp01(1 - meanDiff * 5);
}

function countMatchingFootprints(
  pages: RasterizedPage[],
  reference: RasterizedPage,
  referenceBBox: { x: number; y: number; w: number; h: number },
): number {
  let matches = 0;
  for (const page of pages) {
    if (
      footprintSimilarity(page, reference, referenceBBox) >=
      FOOTPRINT_MATCH_THRESHOLD
    ) {
      matches++;
    }
  }
  return matches;
}
