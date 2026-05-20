import { describe, it, expect } from 'vitest';
import sharp from 'sharp';

import { cropPageToPng, pngToJpeg } from './crop';
import type { RasterizedPage } from '../rasterize/pdfjs';
import type { NormalizedBBox } from './jobStore';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

const startsWith = (buf: Buffer, magic: number[]): boolean => {
  for (let i = 0; i < magic.length; i++) {
    if (buf[i] !== magic[i]) return false;
  }
  return true;
};

// Build a synthetic page with a deterministic ink rectangle in the middle so
// downstream tests can verify the crop captures specifically that ink.
const makePage = (width: number, height: number): RasterizedPage => {
  const color = new Uint8ClampedArray(width * height * 4);
  const greyscale = new Uint8ClampedArray(width * height);
  for (let i = 0; i < greyscale.length; i++) greyscale[i] = 255;
  for (let i = 0; i < color.length; i += 4) {
    color[i] = 255;
    color[i + 1] = 255;
    color[i + 2] = 255;
    color[i + 3] = 255;
  }
  // Paint a 40×20 black rect at (10, 10) for visual verification.
  for (let y = 10; y < 30; y++) {
    for (let x = 10; x < 50; x++) {
      const idx = (y * width + x) * 4;
      color[idx] = 0;
      color[idx + 1] = 0;
      color[idx + 2] = 0;
      color[idx + 3] = 255;
      greyscale[y * width + x] = 0;
    }
  }
  return { width, height, color, greyscale };
};

describe('cropPageToPng', () => {
  it('returns a valid PNG with the bbox dimensions', async () => {
    const page = makePage(100, 100);
    // Crop the bottom-right quadrant: x=50, y=50, w=50, h=50.
    const bbox: NormalizedBBox = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
    const png = await cropPageToPng(page, bbox);

    expect(Buffer.isBuffer(png)).toBe(true);
    expect(startsWith(png, PNG_MAGIC)).toBe(true);

    // Decode the PNG to verify dimensions match the requested bbox.
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(50);
  });

  it('crops the correct pixels (sample the cropped image)', async () => {
    const page = makePage(100, 100);
    // Crop the area containing the ink rect (0,0)→(60, 40), which includes
    // the painted rect at (10,10)-(49,29).
    const png = await cropPageToPng(page, { x: 0, y: 0, w: 0.6, h: 0.4 });

    const { data, info } = await sharp(png)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(60);
    expect(info.height).toBe(40);

    // Pixel (15, 15) in the crop = pixel (15, 15) of the page = inside the
    // ink rect. Expect black (R/G/B all ~0).
    const pixelOffset = (15 * info.width + 15) * info.channels;
    expect(data[pixelOffset]).toBeLessThan(20);
    expect(data[pixelOffset + 1]).toBeLessThan(20);
    expect(data[pixelOffset + 2]).toBeLessThan(20);

    // Pixel (55, 35) is past the ink rect — expect white.
    const whiteOffset = (35 * info.width + 55) * info.channels;
    expect(data[whiteOffset]).toBeGreaterThan(240);
  });

  it('rejects a bbox with degenerate dimensions', async () => {
    const page = makePage(100, 100);
    // Width 1px after rounding.
    await expect(
      cropPageToPng(page, { x: 0, y: 0, w: 0.005, h: 0.5 }),
    ).rejects.toThrow(/dimensions/i);
  });

  it('rejects a bbox that extends outside the page', async () => {
    const page = makePage(100, 100);
    await expect(
      cropPageToPng(page, { x: 0.5, y: 0.5, w: 0.7, h: 0.7 }),
    ).rejects.toThrow(/(out of bounds|bounds)/i);
  });

  it('rejects negative bbox coordinates', async () => {
    const page = makePage(100, 100);
    await expect(
      cropPageToPng(page, { x: -0.1, y: 0, w: 0.5, h: 0.5 }),
    ).rejects.toThrow();
  });
});

describe('pngToJpeg', () => {
  it('re-encodes a PNG as JPEG with the requested quality', async () => {
    // Generate a small PNG to feed in.
    const page = makePage(100, 100);
    const png = await cropPageToPng(page, { x: 0, y: 0, w: 0.5, h: 0.5 });

    const jpeg = await pngToJpeg(png, 85);
    expect(Buffer.isBuffer(jpeg)).toBe(true);
    expect(startsWith(jpeg, JPEG_MAGIC)).toBe(true);

    // Decode to verify dimensions survived re-encoding.
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(50);
  });

  it('clamps quality to [1, 100] and floors to int', async () => {
    const png = await cropPageToPng(makePage(50, 50), {
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });

    // Out-of-range values should not throw — they should clamp.
    await expect(pngToJpeg(png, -10)).resolves.toBeInstanceOf(Buffer);
    await expect(pngToJpeg(png, 250)).resolves.toBeInstanceOf(Buffer);
    await expect(pngToJpeg(png, 42.7)).resolves.toBeInstanceOf(Buffer);
  });

  it('strips alpha (JPEG has no alpha channel)', async () => {
    const png = await cropPageToPng(makePage(50, 50), {
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
    const jpeg = await pngToJpeg(png, 85);
    const meta = await sharp(jpeg).metadata();
    expect(meta.hasAlpha).toBe(false);
    expect(meta.channels).toBe(3); // RGB
  });
});
