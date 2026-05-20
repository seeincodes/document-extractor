import { describe, it, expect } from 'vitest';
import sharp from 'sharp';

import { imageToPages } from './image';

describe('imageToPages', () => {
  it('converts a PNG buffer to a single RasterizedPage', async () => {
    const png = await sharp({
      create: { width: 50, height: 80, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const pages = await imageToPages(new Uint8Array(png));
    expect(pages).toHaveLength(1);
    const page = pages[0]!;
    expect(page.width).toBe(50);
    expect(page.height).toBe(80);
    expect(page.color.length).toBe(50 * 80 * 4);
    expect(page.greyscale.length).toBe(50 * 80);
  });

  it('converts a JPEG buffer to a single RasterizedPage', async () => {
    const jpeg = await sharp({
      create: { width: 30, height: 40, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .jpeg()
      .toBuffer();

    const pages = await imageToPages(new Uint8Array(jpeg));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.width).toBe(30);
    expect(pages[0]!.height).toBe(40);
  });
});
