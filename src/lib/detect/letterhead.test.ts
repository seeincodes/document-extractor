import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { detectLetterhead } from './letterhead';
import type { RegionResult } from '../extract/jobStore';
import { rasterizePages, type RasterizedPage } from '../rasterize/pdfjs';

const FIXTURE_DIR = resolve(__dirname, '../../../samples');
const readBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(resolve(FIXTURE_DIR, name)));

// Type guard that narrows a detector result to its 'detected' variant for
// subsequent assertions. Throws if the result is null or in a different
// status — used by tests that already separately verified detection.
function expectDetected(
  result: RegionResult | null,
): asserts result is Extract<RegionResult, { status: 'detected' }> {
  if (!result || result.status !== 'detected') {
    throw new Error(
      `expected 'detected' result; got ${result?.status ?? 'null'}`,
    );
  }
}

const makePage = (width: number, height: number, fill = 255): RasterizedPage => {
  const color = new Uint8ClampedArray(width * height * 4);
  const greyscale = new Uint8ClampedArray(width * height);
  for (let i = 0; i < greyscale.length; i++) greyscale[i] = fill;
  for (let i = 0; i < color.length; i += 4) {
    color[i] = fill;
    color[i + 1] = fill;
    color[i + 2] = fill;
    color[i + 3] = 255;
  }
  return { width, height, color, greyscale };
};

// Build a synthetic page where rows [inkStart, inkEnd) are filled with `inkValue`
// (default 0 = pure black). Everything else stays white (255).
const makePageWithInkBand = (
  width: number,
  height: number,
  inkStart: number,
  inkEnd: number,
  inkValue = 0,
): RasterizedPage => {
  const page = makePage(width, height);
  for (let y = inkStart; y < inkEnd; y++) {
    for (let x = 0; x < width; x++) {
      page.greyscale[y * width + x] = inkValue;
    }
  }
  return page;
};

describe('detectLetterhead — default mode', () => {
  it('returns a top-18% bbox on page 1', async () => {
    const pages = [makePage(100, 100)];
    const result = await detectLetterhead(pages, { mode: 'default' });

    expect(result).not.toBeNull();
    expectDetected(result);

    expect(result.bbox).toEqual({ x: 0, y: 0, w: 1, h: 0.18 });
    expect(result.detector).toBe('heuristic');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('uses page 1 even when more pages are provided', async () => {
    const pages = [makePage(50, 50), makePage(80, 80), makePage(100, 100)];
    const result = await detectLetterhead(pages, { mode: 'default' });

    expectDetected(result);
    // bbox is normalized [0,1], so page dimensions don't change the result.
    expect(result.bbox.h).toBe(0.18);
  });

  it('returns not_found when given zero pages', async () => {
    const result = await detectLetterhead([], { mode: 'default' });
    expect(result).not.toBeNull();
    if (!result || result.status !== 'not_found') {
      throw new Error('expected not_found');
    }
    expect(result.reason).toMatch(/no pages/i);
  });

  it('defaults to mode "default" when opts are omitted', async () => {
    const pages = [makePage(100, 100)];
    const result = await detectLetterhead(pages);
    expectDetected(result);
    expect(result.bbox).toEqual({ x: 0, y: 0, w: 1, h: 0.18 });
  });
});

describe('detectLetterhead — smart mode (synthetic buffers)', () => {
  it('finds the boundary just below a clean ink band', async () => {
    // 100×500 page. Ink band rows [50, 100) (10%–20% of height), then clean
    // whitespace from row 100 onwards. The boundary should fall near y=100/500
    // = 0.20.
    const page = makePageWithInkBand(100, 500, 50, 100);
    const result = await detectLetterhead([page], { mode: 'smart' });

    expectDetected(result);
    expect(result.bbox.x).toBe(0);
    expect(result.bbox.y).toBe(0);
    expect(result.bbox.w).toBe(1);
    expect(result.bbox.h).toBeGreaterThanOrEqual(0.19);
    expect(result.bbox.h).toBeLessThanOrEqual(0.22);
    expect(result.detector).toBe('heuristic');
    // Smart mode with a clean boundary should beat the default-mode confidence.
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('falls back to the 18% default when no ink band exists in the scan window', async () => {
    // A fully-blank page: no ink at all → no ink band → fall back to default.
    const page = makePage(100, 500);
    const result = await detectLetterhead([page], { mode: 'smart' });

    expectDetected(result);
    expect(result.bbox.h).toBe(0.18);
    // Falling back to default means we got no real signal; confidence stays
    // at the default-mode prior.
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('ignores thin horizontal rules (1–2 row ink bands) as noise', async () => {
    // A 2-row ink "rule" at rows [50, 52), then whitespace. MIN_INK_ROWS=3
    // should reject this — no qualifying ink band → fall back to default.
    const page = makePageWithInkBand(100, 500, 50, 52);
    const result = await detectLetterhead([page], { mode: 'smart' });

    expectDetected(result);
    expect(result.bbox.h).toBe(0.18);
  });

  it('rejects boundaries that fall above 5% of page height (likely false positive)', async () => {
    // Ink band at the very top (rows 0–4), inter-line gap at row 5. The
    // candidate boundary would be y=5/500 = 0.01 — below MIN_BOUNDARY_Y_RATIO.
    // The algorithm should not accept it and should fall back to the default.
    const page = makePageWithInkBand(100, 500, 0, 5);
    const result = await detectLetterhead([page], { mode: 'smart' });

    expectDetected(result);
    expect(result.bbox.h).toBe(0.18);
  });
});

describe('detectLetterhead — smart mode (real PDF fixtures)', () => {
  // The synthetic fixtures in samples/ rely on standard Type-1 font names
  // (Helvetica, Times) without embedding font programs. pdfjs in Node mode
  // (disableFontFace + !useSystemFonts) silently drops glyphs it cannot
  // resolve, so the rasterized output of these fixtures has no text — only
  // the vector horizontal rule survives. Until samples include embedded
  // fonts (or we land a real-world fixture in samples/.local/), the smart
  // scan cannot find a 3-row-thick ink band and falls back to the default.
  //
  // That fallback IS the documented graceful-degradation behavior. The two
  // assertions below verify the fallback works, not that the smart scan
  // succeeded. The "smart scan finds the right boundary" guarantee is
  // covered by the synthetic-buffer tests above.

  it('returns a valid detection on tall-letterhead.pdf (fallback path tolerated)', async () => {
    const pages = await rasterizePages(readBytes('tall-letterhead.pdf'), {
      dpi: 200,
    });

    const result = await detectLetterhead(pages, { mode: 'smart' });

    expectDetected(result);
    expect(result.bbox.x).toBe(0);
    expect(result.bbox.y).toBe(0);
    expect(result.bbox.w).toBe(1);
    // Either the smart scan succeeded (in the 22–34% window) or it fell
    // back to the 18% default. Both are acceptable until fonts embed.
    expect(result.bbox.h === 0.18 || (result.bbox.h >= 0.22 && result.bbox.h <= 0.34)).toBe(true);
  }, 15_000);

  it('falls back to the 18% default on no-letterhead.pdf', async () => {
    const pages = await rasterizePages(readBytes('no-letterhead.pdf'), {
      dpi: 200,
    });

    const result = await detectLetterhead(pages, { mode: 'smart' });

    expectDetected(result);
    expect(result.bbox.h).toBe(0.18);
  }, 15_000);
});
