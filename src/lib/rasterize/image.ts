import sharp from 'sharp';

import type { RasterizedPage } from './pdfjs';

const MAX_DIMENSION = 12_000;

export async function imageToPages(
  bytes: Uint8Array,
): Promise<RasterizedPage[]> {
  const img = sharp(Buffer.from(bytes));
  const metadata = await img.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (width <= 0 || height <= 0) {
    throw new Error('Image has zero-size dimensions.');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(
      `Image dimensions ${width}x${height} exceed the ${MAX_DIMENSION}px cap.`,
    );
  }

  const rgba = await img
    .ensureAlpha()
    .raw()
    .toBuffer();

  const color = new Uint8ClampedArray(rgba);

  const greyscale = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; j < greyscale.length; i += 4, j++) {
    const r = color[i] ?? 0;
    const g = color[i + 1] ?? 0;
    const b = color[i + 2] ?? 0;
    greyscale[j] = (r * 299 + g * 587 + b * 114 + 500) / 1000;
  }

  return [{ width, height, color, greyscale }];
}
