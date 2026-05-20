import type { RasterizedPage } from '../rasterize/pdfjs';
import type { RegionResult } from '../extract/jobStore';

export type LetterheadMode = 'default' | 'smart';

export interface LetterheadOptions {
  mode?: LetterheadMode;
}

// Heuristic priors. Surface them as named constants so future tuning is a
// one-line search rather than a hunt through arithmetic.
const DEFAULT_CROP_Y_RATIO = 0.18;
const DEFAULT_MODE_CONFIDENCE = 0.5;

// Smart-mode parameters — match the algorithm spec in the group-5 design.
const SCAN_WINDOW_RATIO = 0.35;          // scan the top 35% of the page
const BINARIZE_THRESHOLD = 180;           // pixels < this are "ink"
const MIN_INK_DENSITY_RATIO = 0.1;        // a row needs ≥10% ink to count as inky
const MIN_CONSECUTIVE_INK_ROWS = 3;       // ≥3 consecutive inky rows = an "ink band"
const WHITE_ROW_THRESHOLD = 0.8;          // ≥80% non-ink = a "white row"
const MIN_BOUNDARY_Y_RATIO = 0.05;        // reject boundaries < 5% of height
const MIN_SMART_CONFIDENCE = 0.5;         // below this, fall back to default

// ink density at or above this saturates the "thick ink band" signal at 1.
const FULL_INK_DENSITY_RATIO = 0.3;

// The normalization window for the boundary-row whiteness signal. The window
// runs from WHITE_ROW_THRESHOLD (signal = 0) up to 100% white (signal = 1).
const WHITE_ROW_NORMALIZATION_RANGE = 1 - WHITE_ROW_THRESHOLD;

export async function detectLetterhead(
  pages: RasterizedPage[],
  opts: LetterheadOptions = {},
): Promise<RegionResult | null> {
  if (pages.length === 0) {
    return { status: 'not_found', reason: 'no pages provided' };
  }

  const mode = opts.mode ?? 'default';
  if (mode === 'default') {
    return defaultCrop();
  }

  const page = pages[0];
  if (!page) return defaultCrop();
  return smartScan(page) ?? defaultCrop();
}

function defaultCrop(): RegionResult {
  return {
    status: 'detected',
    bbox: { x: 0, y: 0, w: 1, h: DEFAULT_CROP_Y_RATIO },
    detector: 'heuristic',
    confidence: DEFAULT_MODE_CONFIDENCE,
  };
}

interface RowStats {
  inkRatio: number;    // fraction of pixels darker than BINARIZE_THRESHOLD
}

function computeRowStats(page: RasterizedPage, maxY: number): RowStats[] {
  const { width, greyscale } = page;
  const rows: RowStats[] = new Array<RowStats>(maxY);
  for (let y = 0; y < maxY; y++) {
    let inkCount = 0;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      if ((greyscale[rowStart + x] ?? 255) < BINARIZE_THRESHOLD) inkCount++;
    }
    rows[y] = { inkRatio: inkCount / width };
  }
  return rows;
}

function findFirstInkBand(rows: RowStats[]): number | null {
  // Slide a window of MIN_CONSECUTIVE_INK_ROWS; return the index where the
  // first window of all-inky rows starts.
  for (let y = 0; y <= rows.length - MIN_CONSECUTIVE_INK_ROWS; y++) {
    let allInky = true;
    for (let k = 0; k < MIN_CONSECUTIVE_INK_ROWS; k++) {
      if ((rows[y + k]?.inkRatio ?? 0) < MIN_INK_DENSITY_RATIO) {
        allInky = false;
        break;
      }
    }
    if (allInky) return y;
  }
  return null;
}

function findFirstWhiteRow(rows: RowStats[], from: number): number | null {
  for (let y = from; y < rows.length; y++) {
    const inkRatio = rows[y]?.inkRatio ?? 0;
    if (1 - inkRatio >= WHITE_ROW_THRESHOLD) return y;
  }
  return null;
}

function bandInkDensity(
  rows: RowStats[],
  bandStart: number,
  bandEnd: number,
): number {
  let sum = 0;
  for (let y = bandStart; y < bandEnd; y++) {
    sum += rows[y]?.inkRatio ?? 0;
  }
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
  boundaryYRatio: number,
): number {
  // Three weighted signals per the design report. Each is mapped to [0, 1]
  // where 1 = strongest evidence for a real letterhead.
  //  * inkDensitySignal — denser band = more credible letterhead
  //  * whitenessSignal  — cleaner boundary row = more credible gap
  //  * depthSignal      — boundaries near the default 18% are suspicious;
  //                       boundaries 18–35% are most credible
  const inkDensitySignal = clamp01(bandDensity / FULL_INK_DENSITY_RATIO);
  const whitenessSignal = clamp01(
    (1 - whiteRowInkRatio - WHITE_ROW_THRESHOLD) /
      WHITE_ROW_NORMALIZATION_RANGE,
  );

  let depthSignal: number;
  if (boundaryYRatio < MIN_BOUNDARY_Y_RATIO || boundaryYRatio > SCAN_WINDOW_RATIO) {
    depthSignal = 0;
  } else if (boundaryYRatio < DEFAULT_CROP_Y_RATIO) {
    depthSignal =
      (boundaryYRatio - MIN_BOUNDARY_Y_RATIO) /
      (DEFAULT_CROP_Y_RATIO - MIN_BOUNDARY_Y_RATIO);
  } else {
    depthSignal = 1;
  }

  return 0.25 * inkDensitySignal + 0.35 * whitenessSignal + 0.4 * depthSignal;
}

function smartScan(page: RasterizedPage): RegionResult | null {
  const maxY = Math.floor(page.height * SCAN_WINDOW_RATIO);
  if (maxY < MIN_CONSECUTIVE_INK_ROWS + 1) return null;

  const rows = computeRowStats(page, maxY);

  const bandStart = findFirstInkBand(rows);
  if (bandStart === null) return null;

  const boundary = findFirstWhiteRow(rows, bandStart + MIN_CONSECUTIVE_INK_ROWS);
  if (boundary === null) return null;

  const boundaryYRatio = boundary / page.height;
  if (boundaryYRatio < MIN_BOUNDARY_Y_RATIO) return null;

  const bandDensity = bandInkDensity(rows, bandStart, boundary);
  const whiteRowInkRatio = rows[boundary]?.inkRatio ?? 0;
  const confidence = scoreConfidence(bandDensity, whiteRowInkRatio, boundaryYRatio);

  if (confidence < MIN_SMART_CONFIDENCE) return null;

  return {
    status: 'detected',
    bbox: { x: 0, y: 0, w: 1, h: boundaryYRatio },
    detector: 'heuristic',
    confidence,
  };
}
