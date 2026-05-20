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

  it('detectFooter() returns a detected RegionResult on a valid page', async () => {
    const pages = await defaultStages.rasterize(readBytes(CLEAN_LETTER));
    const result = await defaultStages.detectFooter(pages, 'j_test');

    expect(result).not.toBeNull();
    if (!result || result.status !== 'detected') {
      throw new Error(`expected detected; got ${result?.status ?? 'null'}`);
    }
    expect(result.detector).toBe('heuristic');
    expect(result.confidence).toBeGreaterThan(0);
  }, 15_000);

  it('detectSignature() returns a typed result on a valid page', async () => {
    const pages = await defaultStages.rasterize(readBytes(CLEAN_LETTER));
    const result = await defaultStages.detectSignature(pages, 'j_test');

    // Either a detected signature (clean-letter.pdf has a vector signature
    // stroke that rasterizes successfully) or a typed not_found result.
    // Both are valid outcomes of the heuristic on this fixture.
    if (result?.status === 'detected') {
      expect(result.detector).toBe('heuristic');
      expect(result.confidence).toBeGreaterThan(0);
    } else if (result?.status === 'not_found') {
      expect(result.reason).toBeTruthy();
    } else {
      throw new Error(`unexpected result shape: ${String(result?.status)}`);
    }
  }, 15_000);
});
