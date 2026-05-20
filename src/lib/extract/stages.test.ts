import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defaultStages } from './stages';

const CLEAN_LETTER = resolve(__dirname, '../../../samples/clean-letter.pdf');
const readBytes = (path: string): Uint8Array =>
  new Uint8Array(readFileSync(path));

describe('defaultStages', () => {
  it('rasterize() returns at least one page for a valid PDF', async () => {
    const pages = await defaultStages.rasterize(readBytes(CLEAN_LETTER));
    expect(pages.length).toBeGreaterThan(0);
    const first = pages[0];
    expect(first?.width).toBeGreaterThan(0);
    expect(first?.height).toBeGreaterThan(0);
  }, 15_000);

  it('detectLetterhead() returns a detected RegionResult on a valid page', async () => {
    const pages = await defaultStages.rasterize(readBytes(CLEAN_LETTER));
    const result = await defaultStages.detectLetterhead(pages, 'j_test');

    expect(result).not.toBeNull();
    if (!result || result.status !== 'detected') {
      throw new Error(`expected detected; got ${result?.status ?? 'null'}`);
    }
    expect(result.detector).toBe('heuristic');
    expect(result.confidence).toBeGreaterThan(0);
  }, 15_000);

  it('detectFooter() and detectSignature() return null until their groups land', async () => {
    const pages = await defaultStages.rasterize(readBytes(CLEAN_LETTER));
    expect(await defaultStages.detectFooter(pages, 'j_test')).toBeNull();
    expect(await defaultStages.detectSignature(pages, 'j_test')).toBeNull();
  }, 15_000);
});
