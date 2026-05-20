import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { detectSignature } from './signature';
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

// Draw a solid black filled rectangle into the greyscale buffer of `page`.
// Used to plant synthetic "signature-shaped" components for unit tests.
const drawRect = (
  page: RasterizedPage,
  x: number,
  y: number,
  w: number,
  h: number,
): void => {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      page.greyscale[yy * page.width + xx] = 0;
    }
  }
};

describe('detectSignature — empty / null cases', () => {
  it('returns not_found when given zero pages', async () => {
    const result = await detectSignature([]);
    expect(result).not.toBeNull();
    if (!result || result.status !== 'not_found') {
      throw new Error('expected not_found');
    }
    expect(result.reason).toMatch(/no pages/i);
  });

  it('returns not_found on a completely blank page', async () => {
    const result = await detectSignature([makePage(500, 1000)]);
    expect(result).not.toBeNull();
    if (!result || result.status !== 'not_found') {
      throw new Error('expected not_found');
    }
    expect(result.reason).toMatch(/no candidate/i);
  });
});

describe('detectSignature — synthetic single-component', () => {
  it('finds a signature-shaped rectangle in the bottom 30%', async () => {
    // 500×1000 page; rect at (50, 800)→(250, 870). Width 200, height 70:
    // aspect ratio ~2.86:1 (inside the 2:1–6:1 window). Lives in the
    // bottom 30% (rows 700–999), specifically rows 800–870.
    const page = makePage(500, 1000);
    drawRect(page, 50, 800, 200, 70);

    const result = await detectSignature([page]);
    expectDetected(result);
    expect(result.detector).toBe('heuristic');
    expect(result.confidence).toBeGreaterThan(0);

    // bbox should overlap the rectangle's region in normalized coords.
    expect(result.bbox.x).toBeCloseTo(50 / 500, 1);
    expect(result.bbox.y).toBeCloseTo(800 / 1000, 1);
    expect(result.bbox.w).toBeCloseTo(200 / 500, 1);
    expect(result.bbox.h).toBeCloseTo(70 / 1000, 1);
  });

  it('rejects a component with too-square aspect ratio (< 2:1)', async () => {
    // 100×100 black box (aspect 1:1) — looks like a stamp, not a signature.
    const page = makePage(500, 1000);
    drawRect(page, 200, 800, 100, 100);

    const result = await detectSignature([page]);
    if (!result || result.status !== 'not_found') {
      throw new Error('expected not_found, got ' + (result?.status ?? 'null'));
    }
  });

  it('rejects a component with too-elongated aspect ratio (> 6:1)', async () => {
    // 480×40 black bar (aspect 12:1) — looks like a printed line or rule.
    const page = makePage(500, 1000);
    drawRect(page, 10, 850, 480, 40);

    const result = await detectSignature([page]);
    if (!result || result.status !== 'not_found') {
      throw new Error('expected not_found, got ' + (result?.status ?? 'null'));
    }
  });

  it('rejects a component that is too small (likely noise)', async () => {
    // 6×3 px speck.
    const page = makePage(500, 1000);
    drawRect(page, 200, 850, 6, 3);

    const result = await detectSignature([page]);
    if (!result || result.status !== 'not_found') {
      throw new Error('expected not_found');
    }
  });

  it('ignores components OUTSIDE the bottom 30% scan window', async () => {
    // Signature-shaped rect at (50, 100) — top of the page, well outside
    // the bottom 30% (rows 700+).
    const page = makePage(500, 1000);
    drawRect(page, 50, 100, 200, 70);

    const result = await detectSignature([page]);
    if (!result || result.status !== 'not_found') {
      throw new Error('expected not_found');
    }
  });
});

describe('detectSignature — multi-component selection', () => {
  it('picks the largest qualifying component when multiple are present', async () => {
    // Two signature-shaped rects in the bottom 30%, one smaller than the
    // other. The detector should pick the larger one.
    const page = makePage(500, 1000);
    drawRect(page, 50, 750, 100, 35);   // smaller: 100x35 = 3500 px
    drawRect(page, 50, 850, 240, 84);   // larger: 240x84 = 20160 px

    const result = await detectSignature([page]);
    expectDetected(result);
    // The larger rect lives near y=850/1000.
    expect(result.bbox.y).toBeCloseTo(850 / 1000, 1);
    expect(result.bbox.w).toBeCloseTo(240 / 500, 1);
  });

  it('uses the LAST page when multiple pages are provided', async () => {
    const pageA = makePage(500, 1000);
    const pageB = makePage(500, 1000);
    drawRect(pageA, 50, 800, 200, 70);  // signature on first page
    drawRect(pageB, 50, 900, 300, 60);  // different signature on last page

    const result = await detectSignature([pageA, pageB]);
    expectDetected(result);
    // The detector should land on pageB's rectangle, not pageA's.
    expect(result.bbox.y).toBeCloseTo(900 / 1000, 1);
  });
});

describe('detectSignature — confidence scoring', () => {
  it('scores an isolated, signature-shaped component higher than a noisy one', async () => {
    const isolated = makePage(500, 1000);
    drawRect(isolated, 100, 850, 240, 60);
    const isolatedResult = await detectSignature([isolated]);
    expectDetected(isolatedResult);

    // Same signature shape but surrounded by speckle noise that crowds it.
    const noisy = makePage(500, 1000);
    drawRect(noisy, 100, 850, 240, 60);
    for (let i = 0; i < 60; i++) {
      // small specks scattered nearby in the bottom 30%
      const x = 50 + i * 8;
      const y = 720 + (i % 5) * 30;
      drawRect(noisy, x, y, 3, 3);
    }
    const noisyResult = await detectSignature([noisy]);
    expectDetected(noisyResult);

    expect(isolatedResult.confidence).toBeGreaterThan(noisyResult.confidence);
  });
});

describe('detectSignature — real PDF fixtures', () => {
  it('returns a sensible result for samples/clean-letter.pdf', async () => {
    const pages = await rasterizePages(
      readBytes(resolve(FIXTURE_DIR, 'clean-letter.pdf')),
      { dpi: 200 },
    );
    const result = await detectSignature(pages);

    // clean-letter.pdf has a vector signature stroke that rasterizes (unlike
    // its text content). The detector should either find it (status:
    // 'detected' with a bbox in the bottom 30%) or cleanly return null.
    if (result?.status === 'detected') {
      // bottom 30% means y ≥ 0.7 of the page
      expect(result.bbox.y).toBeGreaterThanOrEqual(0.65);
    } else if (result?.status === 'not_found') {
      expect(result.reason).toBeTruthy();
    } else {
      throw new Error('unexpected result shape');
    }
  }, 15_000);

  const PRIVATE_FIXTURE = resolve(PRIVATE_FIXTURE_DIR, 'moro-letter.pdf');
  it.runIf(existsSync(PRIVATE_FIXTURE))(
    'detects a signature on the real-world NYSCEF moro-letter.pdf',
    async () => {
      const pages = await rasterizePages(readBytes(PRIVATE_FIXTURE), {
        dpi: 200,
      });
      const result = await detectSignature(pages);

      expectDetected(result);
      // The bbox lives somewhere in the bottom ~30% of the last page.
      expect(result.bbox.y).toBeGreaterThanOrEqual(0.65);
      expect(result.bbox.y + result.bbox.h).toBeLessThanOrEqual(1.0);
      expect(result.confidence).toBeGreaterThan(0);
    },
    30_000,
  );
});
