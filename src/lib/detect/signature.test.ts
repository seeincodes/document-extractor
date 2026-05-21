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

function expectFound(
  result: RegionResult | null,
): asserts result is Exclude<RegionResult, { status: 'not_found' }> {
  if (!result || result.status === 'not_found') {
    throw new Error(
      `expected 'detected' or 'unverified' result; got ${result?.status ?? 'null'}`,
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

// Draw a solid black filled rectangle. Used for rejection tests where
// we need shapes that fail area/aspect filters (the fill ratio doesn't
// matter because earlier checks reject first).
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

// Draw a sparse connected stroke into the greyscale buffer. Simulates a
// handwritten signature with fill ratio ~5–10%, well below MAX_FILL_RATIO.
// The stroke is a thick zigzag that forms a single connected component.
const drawStroke = (
  page: RasterizedPage,
  x: number,
  y: number,
  w: number,
  h: number,
): void => {
  const thickness = Math.max(4, Math.ceil(h * 0.12));
  // Limit zigzag amplitude so max per-row shift < thickness (ensures
  // 4-connectivity between consecutive rows).
  const maxSafeAmplitude = (thickness * h) / (2 * Math.PI * (w - thickness));
  const amplitude = Math.min(0.4, maxSafeAmplitude * 0.8);
  for (let yy = y; yy < y + h; yy++) {
    const progress = (yy - y) / h;
    const zigzag = Math.sin(progress * Math.PI * 2) * amplitude + 0.5;
    const centerX = x + Math.floor(zigzag * (w - thickness));
    for (let dx = 0; dx < thickness; dx++) {
      const xx = centerX + dx;
      if (xx >= x && xx < x + w) {
        page.greyscale[yy * page.width + xx] = 0;
      }
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
  it('finds a signature-shaped stroke in the bottom 30%', async () => {
    // 500×1000 page; stroke at (50, 800) spanning 200×70. Aspect ratio
    // ~2.3:1 (inside the 1.5:1–20:1 window). Sparse fill (<15%).
    const page = makePage(500, 1000);
    drawStroke(page, 50, 800, 200, 70);

    const result = await detectSignature([page]);
    expectFound(result);
    expect(result.detector).toBe('heuristic');
    expect(result.confidence).toBeGreaterThan(0);

    // bbox should overlap the stroke's region in normalized coords.
    expect(result.bbox.y).toBeCloseTo(800 / 1000, 1);
    expect(result.bbox.h).toBeCloseTo(70 / 1000, 1);
  });

  it('rejects a component with too-square aspect ratio (< 1.5:1)', async () => {
    // 100×100 black box (aspect 1:1) — looks like a stamp, not a signature.
    const page = makePage(500, 1000);
    drawRect(page, 200, 800, 100, 100);

    const result = await detectSignature([page]);
    if (!result || result.status !== 'not_found') {
      throw new Error('expected not_found, got ' + (result?.status ?? 'null'));
    }
  });

  it('rejects a component with too-elongated aspect ratio (> 20:1)', async () => {
    // 490×10 black bar (aspect 49:1) — looks like a printed line or rule.
    const page = makePage(500, 1000);
    drawRect(page, 5, 850, 490, 10);

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

  it('detects components anywhere on the page (full-page scan)', async () => {
    // Signature-shaped stroke near the top of the page. The algorithm scans
    // the full page so this should be detected regardless of position.
    const page = makePage(500, 1000);
    drawStroke(page, 50, 100, 200, 70);

    const result = await detectSignature([page]);
    expectFound(result);
    expect(result.bbox.y).toBeCloseTo(100 / 1000, 1);
  });
});

describe('detectSignature — multi-component selection', () => {
  it('picks the largest qualifying component when multiple are present', async () => {
    // Two signature-shaped strokes, one smaller than the other.
    // The detector should pick the larger one (higher area → higher score).
    const page = makePage(500, 1000);
    drawStroke(page, 50, 750, 100, 35);   // smaller
    drawStroke(page, 50, 850, 240, 84);   // larger

    const result = await detectSignature([page]);
    expectFound(result);
    // The larger stroke lives near y=850/1000.
    expect(result.bbox.y).toBeCloseTo(850 / 1000, 1);
  });

  it('picks the best candidate across all pages', async () => {
    const pageA = makePage(500, 1000);
    const pageB = makePage(500, 1000);
    drawStroke(pageA, 50, 800, 200, 70);  // smaller signature on first page
    drawStroke(pageB, 50, 850, 400, 100); // much larger signature on last page

    const result = await detectSignature([pageA, pageB]);
    expectFound(result);
    // pageB's stroke has more ink pixels → higher area → higher score.
    expect(result.pageIndex).toBe(1);
    expect(result.bbox.y).toBeCloseTo(850 / 1000, 1);
  });
});

describe('detectSignature — confidence scoring', () => {
  it('scores an isolated, signature-shaped component higher than a crowded one', async () => {
    const isolated = makePage(800, 1200);
    drawStroke(isolated, 100, 1000, 400, 100);
    const isolatedResult = await detectSignature([isolated]);
    expectFound(isolatedResult);

    // Same signature shape but tightly crowded by other candidates.
    const crowded = makePage(800, 1200);
    drawStroke(crowded, 100, 1000, 400, 100); // primary
    drawStroke(crowded, 120, 920, 350, 70);   // very close above (centroid ~80px away)
    drawStroke(crowded, 80, 1110, 300, 70);   // very close below
    const crowdedResult = await detectSignature([crowded]);
    expectFound(crowdedResult);

    expect(isolatedResult.confidence).toBeGreaterThan(crowdedResult.confidence);
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
    if (result?.status === 'detected' || result?.status === 'unverified') {
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
