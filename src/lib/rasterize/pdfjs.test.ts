import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { rasterizePages, type RasterizeError } from './pdfjs';

const CLEAN_LETTER = resolve(__dirname, '../../../samples/clean-letter.pdf');
const ENCRYPTED = resolve(__dirname, '../../../tests/fixtures/encrypted.pdf');
const MALFORMED = resolve(__dirname, '../../../tests/fixtures/malformed.pdf');

const readBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));

describe('rasterizePages', () => {
  it('renders a 1-page letter at 200 DPI with RGBA + greyscale buffers', async () => {
    const [page, ...rest] = await rasterizePages(readBytes(CLEAN_LETTER), {
      dpi: 200,
    });
    expect(page).toBeDefined();
    expect(rest).toHaveLength(0);
    if (!page) return;

    // US Letter is 612pt × 792pt. At 200 DPI: 612/72*200 = 1700, 792/72*200 = 2200.
    expect(page.width).toBe(1700);
    expect(page.height).toBe(2200);

    // RGBA buffer: 4 bytes per pixel.
    expect(page.color).toBeInstanceOf(Uint8ClampedArray);
    expect(page.color.length).toBe(page.width * page.height * 4);

    // Greyscale buffer: 1 byte per pixel.
    expect(page.greyscale).toBeInstanceOf(Uint8ClampedArray);
    expect(page.greyscale.length).toBe(page.width * page.height);

    // The clean-letter has ink on it, so a non-trivial number of pixels
    // must be darker than near-white. A full sweep is ~3.74M ops, microseconds.
    let darkPixelCount = 0;
    for (const value of page.greyscale) {
      if (value < 200) darkPixelCount++;
    }
    expect(darkPixelCount).toBeGreaterThan(1000);
  });

  it('throws ENCRYPTED_PDF when the input is password-protected', async () => {
    await expect(rasterizePages(readBytes(ENCRYPTED))).rejects.toMatchObject({
      name: 'RasterizeError',
      code: 'ENCRYPTED_PDF',
    } satisfies Partial<RasterizeError>);
  });

  it('throws MALFORMED_PDF when the input is not a valid PDF body', async () => {
    await expect(rasterizePages(readBytes(MALFORMED))).rejects.toMatchObject({
      name: 'RasterizeError',
      code: 'MALFORMED_PDF',
    } satisfies Partial<RasterizeError>);
  });

  it('throws PAGE_LIMIT_EXCEEDED before rendering when page count exceeds the cap', async () => {
    // The cap is enforced via the maxPages option. Setting it below the doc's
    // page count exercises the guard without needing a >50-page fixture.
    await expect(
      rasterizePages(readBytes(CLEAN_LETTER), { maxPages: 0 }),
    ).rejects.toMatchObject({
      name: 'RasterizeError',
      code: 'PAGE_LIMIT_EXCEEDED',
    } satisfies Partial<RasterizeError>);
  });
});
