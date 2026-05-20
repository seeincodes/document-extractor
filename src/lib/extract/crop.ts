import sharp from 'sharp';

import type { RasterizedPage } from '../rasterize/pdfjs';
import type { NormalizedBBox } from './jobStore';

const MIN_CROP_DIMENSION_PX = 2;
const DEFAULT_JPEG_QUALITY = 85;

// Convert a normalized bbox (all coords in [0, 1]) into integer pixel
// coordinates clamped to the page. Throws if the result is degenerate
// (too small) or out of bounds, so callers get a clear error rather than
// a confusing sharp failure later.
function normalizedToPixels(
  bbox: NormalizedBBox,
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number; w: number; h: number } {
  if (bbox.x < 0 || bbox.y < 0 || bbox.w <= 0 || bbox.h <= 0) {
    throw new Error(
      `Invalid bbox coordinates: ${JSON.stringify(bbox)} — all values must be non-negative.`,
    );
  }
  if (bbox.x + bbox.w > 1 || bbox.y + bbox.h > 1) {
    throw new Error(
      `Bbox ${JSON.stringify(bbox)} extends out of bounds [0, 1].`,
    );
  }

  const x = Math.floor(bbox.x * pageWidth);
  const y = Math.floor(bbox.y * pageHeight);
  const w = Math.floor(bbox.w * pageWidth);
  const h = Math.floor(bbox.h * pageHeight);

  if (w < MIN_CROP_DIMENSION_PX || h < MIN_CROP_DIMENSION_PX) {
    throw new Error(
      `Crop dimensions ${w}×${h} too small (min ${MIN_CROP_DIMENSION_PX}×${MIN_CROP_DIMENSION_PX}).`,
    );
  }
  return { x, y, w, h };
}

export async function cropPageToPng(
  page: RasterizedPage,
  bbox: NormalizedBBox,
): Promise<Buffer> {
  const { x, y, w, h } = normalizedToPixels(bbox, page.width, page.height);

  // Hand sharp the raw RGBA buffer + dimensions and use its extract() to
  // slice out the bbox region. sharp's extract is bounds-checked internally,
  // but we already validated above so it shouldn't fire here.
  return sharp(Buffer.from(page.color), {
    raw: { width: page.width, height: page.height, channels: 4 },
  })
    .extract({ left: x, top: y, width: w, height: h })
    .png()
    .toBuffer();
}

export async function pngToJpeg(
  pngBuffer: Buffer,
  quality: number = DEFAULT_JPEG_QUALITY,
): Promise<Buffer> {
  // Clamp quality to [1, 100] and floor to int. Out-of-range or non-integer
  // values are coerced silently rather than thrown — the route handler
  // passes user input through and we want to be tolerant at the boundary.
  const q = Math.max(1, Math.min(100, Math.floor(quality)));

  return sharp(pngBuffer)
    .removeAlpha()
    .jpeg({ quality: q })
    .toBuffer();
}
