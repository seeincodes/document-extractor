import { describe, it, expect } from 'vitest';

import { detectLetterhead } from './letterhead';
import type { RasterizedPage } from '../rasterize/pdfjs';

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

describe('detectLetterhead — default mode', () => {
  it('returns a top-18% bbox on page 1', async () => {
    const pages = [makePage(100, 100)];
    const result = await detectLetterhead(pages, { mode: 'default' });

    expect(result).not.toBeNull();
    if (!result || result.status !== 'detected') throw new Error('expected detected');

    expect(result.bbox).toEqual({ x: 0, y: 0, w: 1, h: 0.18 });
    expect(result.detector).toBe('heuristic');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('uses page 1 even when more pages are provided', async () => {
    const pages = [makePage(50, 50), makePage(80, 80), makePage(100, 100)];
    const result = await detectLetterhead(pages, { mode: 'default' });

    if (!result || result.status !== 'detected') throw new Error('expected detected');
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
    if (!result || result.status !== 'detected') throw new Error('expected detected');
    expect(result.bbox).toEqual({ x: 0, y: 0, w: 1, h: 0.18 });
  });
});
