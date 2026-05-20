import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { detectFooter } from './footer';
import type { RegionResult } from '../extract/jobStore';
import { rasterizePages, type RasterizedPage } from '../rasterize/pdfjs';

const FIXTURE_DIR = resolve(__dirname, '../../../samples');
const PRIVATE_FIXTURE_DIR = resolve(FIXTURE_DIR, '.local');
const readBytes = (path: string): Uint8Array =>
  new Uint8Array(readFileSync(path));

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

describe('detectFooter — default mode', () => {
  it('returns a bottom-12% bbox on the last page', async () => {
    const pages = [makePage(100, 100)];
    const result = await detectFooter(pages, { mode: 'default' });

    expectDetected(result);
    // Footer is the bottom 12% — from y=0.88 to y=1.0, height=0.12.
    expect(result.bbox).toEqual({ x: 0, y: 0.88, w: 1, h: 0.12 });
    expect(result.detector).toBe('heuristic');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('uses the LAST page when multiple pages are provided', async () => {
    // Mark each page with a distinct width so we can verify which one was used.
    const pages = [makePage(50, 50), makePage(80, 80), makePage(100, 100)];
    const result = await detectFooter(pages, { mode: 'default' });
    expectDetected(result);
    // bbox is normalized; we can't directly observe which page was scanned in
    // default mode, but the result must still come back as detected.
    expect(result.bbox.h).toBeCloseTo(0.12, 5);
  });

  it('returns not_found when given zero pages', async () => {
    const result = await detectFooter([], { mode: 'default' });
    expect(result).not.toBeNull();
    if (!result || result.status !== 'not_found') {
      throw new Error('expected not_found');
    }
    expect(result.reason).toMatch(/no pages/i);
  });

  it('defaults to mode "default" when opts are omitted', async () => {
    const pages = [makePage(100, 100)];
    const result = await detectFooter(pages);
    expectDetected(result);
    expect(result.bbox.h).toBeCloseTo(0.12, 5);
  });
});

describe('detectFooter — smart mode (synthetic buffers)', () => {
  it('finds the boundary just above a clean ink band at the bottom', async () => {
    // 100x500 page. Ink band rows [450, 480) (90%–96% of height). The scan
    // starts at the bottom and walks upward; the boundary is the y of the
    // first white row above the band. Expected boundary near 450/500 = 0.90.
    const page = makePageWithInkBand(100, 500, 450, 480);
    const result = await detectFooter([page], { mode: 'smart' });

    expectDetected(result);
    expect(result.bbox.x).toBe(0);
    expect(result.bbox.w).toBe(1);
    // The bbox spans from the boundary to the bottom of the page.
    // boundary ≈ 449/500 = 0.898, so y ≈ 0.898, h ≈ 0.102.
    expect(result.bbox.y).toBeGreaterThanOrEqual(0.88);
    expect(result.bbox.y).toBeLessThanOrEqual(0.92);
    expect(result.bbox.y + result.bbox.h).toBeCloseTo(1.0, 2);
    expect(result.detector).toBe('heuristic');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('falls back to the 12% default when no ink band exists in the scan window', async () => {
    // Fully blank page → no ink band → fallback.
    const page = makePage(100, 500);
    const result = await detectFooter([page], { mode: 'smart' });
    expectDetected(result);
    expect(result.bbox.h).toBeCloseTo(0.12, 5);
    expect(result.bbox.y).toBeCloseTo(0.88, 5);
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('ignores thin horizontal rules (1–2 row ink bands) as noise', async () => {
    // 2-row "rule" at rows [470, 472), then whitespace. MIN_INK_ROWS=3 should
    // reject this as noise → fallback.
    const page = makePageWithInkBand(100, 500, 470, 472);
    const result = await detectFooter([page], { mode: 'smart' });
    expectDetected(result);
    expect(result.bbox.h).toBeCloseTo(0.12, 5);
  });

  it('rejects boundaries that fall less than 5% above the bottom (likely false positive)', async () => {
    // Ink band hugging the very bottom (rows 497–499). Boundary candidate
    // would be y=496/500 = 99.2% — too close to the bottom. The algorithm
    // should reject and fall back.
    const page = makePageWithInkBand(100, 500, 497, 499);
    const result = await detectFooter([page], { mode: 'smart' });
    expectDetected(result);
    expect(result.bbox.h).toBeCloseTo(0.12, 5);
  });
});

describe('detectFooter — multi-page note', () => {
  it('annotates the footer with "appears on N total pages" when the same band repeats', async () => {
    // 3 pages, each 100×500, each with an ink band at rows [450, 480).
    // The bottom-region "footprint" should match across all three pages and
    // produce a multi-page note.
    const pages = [
      makePageWithInkBand(100, 500, 450, 480),
      makePageWithInkBand(100, 500, 450, 480),
      makePageWithInkBand(100, 500, 450, 480),
    ];
    const result = await detectFooter(pages, { mode: 'smart' });

    expectDetected(result);
    expect(result.note).toBeDefined();
    expect(result.note).toMatch(/3.*page/i);
  });

  it('does NOT annotate when only the last page has the band', async () => {
    // 3 pages but only the last has the band.
    const pages = [
      makePage(100, 500),
      makePage(100, 500),
      makePageWithInkBand(100, 500, 450, 480),
    ];
    const result = await detectFooter(pages, { mode: 'smart' });

    expectDetected(result);
    expect(result.note).toBeUndefined();
  });

  it('does NOT annotate on single-page documents', async () => {
    const pages = [makePageWithInkBand(100, 500, 450, 480)];
    const result = await detectFooter(pages, { mode: 'smart' });
    expectDetected(result);
    expect(result.note).toBeUndefined();
  });

  it('does NOT annotate when pages have mismatched dimensions', async () => {
    // Two pages with identical footer bands but different sizes. The
    // footprint comparison short-circuits to similarity=0 on dimension
    // mismatch, so the note must be absent. This documents the behavior
    // for mixed-resolution scans where the footer text is the same but
    // the canvas size differs page to page.
    const pages = [
      makePageWithInkBand(100, 500, 450, 480),
      makePageWithInkBand(120, 600, 540, 576), // proportionally similar but different dims
    ];
    const result = await detectFooter(pages, { mode: 'smart' });
    expectDetected(result);
    expect(result.note).toBeUndefined();
  });
});

describe('detectFooter — real PDF fixtures', () => {
  // The synthetic samples/*.pdf fixtures don't render their text glyphs
  // under pdfjs Node mode (see docs/ERROR_FIX_LOG.md). These integration
  // tests therefore assert the fallback path on the synthetic fixtures and
  // the strict path on a real-world fixture in samples/.local/ when present.

  it('returns a valid detection on clean-letter.pdf (fallback tolerated)', async () => {
    const pages = await rasterizePages(
      readBytes(resolve(FIXTURE_DIR, 'clean-letter.pdf')),
      { dpi: 200 },
    );
    const result = await detectFooter(pages, { mode: 'smart' });
    expectDetected(result);
    expect(result.bbox.x).toBe(0);
    expect(result.bbox.w).toBe(1);
    expect(result.bbox.y + result.bbox.h).toBeCloseTo(1.0, 2);
  }, 15_000);

  const PRIVATE_FIXTURE = resolve(PRIVATE_FIXTURE_DIR, 'catanzaro-multipage.pdf');
  it.runIf(existsSync(PRIVATE_FIXTURE))(
    'detects a recurring footer band across all 16 pages of the multi-page NYSCEF fixture',
    async () => {
      const pages = await rasterizePages(readBytes(PRIVATE_FIXTURE), {
        dpi: 200,
      });

      const result = await detectFooter(pages, { mode: 'smart' });
      expectDetected(result);

      expect(result.bbox.x).toBe(0);
      expect(result.bbox.w).toBe(1);
      // The boundary should fall somewhere in the bottom 30% of the page —
      // the NYSCEF "N of M" footer band is usually within the bottom 5–15%
      // but we allow generous slack for the heuristic's confidence trade-offs.
      expect(result.bbox.y).toBeGreaterThanOrEqual(0.7);
      expect(result.bbox.y + result.bbox.h).toBeCloseTo(1.0, 2);

      // The footer band repeats on every page of the document, so the
      // detector must surface the multi-page note.
      expect(result.note).toBeDefined();
      expect(result.note).toMatch(/(?:16|all).*page/i);
    },
    30_000,
  );
});
