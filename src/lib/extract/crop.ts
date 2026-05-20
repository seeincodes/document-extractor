import sharp from 'sharp';

import type { RasterizedPage } from '../rasterize/pdfjs';
import type { NormalizedBBox } from './jobStore';

const MIN_CROP_DIMENSION_PX = 2;
const DEFAULT_JPEG_QUALITY = 85;

// Convert a normalized bbox (all coords in [0, 1]) into integer pixel
// coordinates. Negative coordinates and non-positive widths/heights are
// rejected (those are caller bugs, not detector imprecision). Epsilon
// overshoot at the page boundary — e.g. bbox.y + bbox.h = 1.0000000000000002
// from floating-point arithmetic in a detector — is silently clamped to
// the page extent rather than thrown, so a legitimate full-page bbox
// doesn't get killed by the boundary check.
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

  const x = Math.floor(bbox.x * pageWidth);
  const y = Math.floor(bbox.y * pageHeight);
  // Clamp width/height to the remaining page extent so epsilon overshoot
  // produces a slightly-smaller crop instead of an error.
  const w = Math.min(Math.floor(bbox.w * pageWidth), pageWidth - x);
  const h = Math.min(Math.floor(bbox.h * pageHeight), pageHeight - y);

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
  // Clamp quality to [1, 100] and floor to int. Out-of-range, non-integer,
  // or non-finite values (e.g. NaN from Number('abc')) fall back to the
  // default — the route handler passes user input through and we want to
  // be tolerant at the boundary.
  const q = Number.isFinite(quality)
    ? Math.max(1, Math.min(100, Math.floor(quality)))
    : DEFAULT_JPEG_QUALITY;

  return sharp(pngBuffer)
    .removeAlpha()
    .jpeg({ quality: q })
    .toBuffer();
}
