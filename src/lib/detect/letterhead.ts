import type { RasterizedPage } from '../rasterize/pdfjs';
import type { RegionResult } from '../extract/jobStore';

export type LetterheadMode = 'default' | 'smart';

export interface LetterheadOptions {
  mode?: LetterheadMode;
}

// Heuristic priors. Surface them as named constants so future tuning is a
// one-line search rather than a hunt through arithmetic.
const DEFAULT_CROP_Y_RATIO = 0.18;
const DEFAULT_MODE_CONFIDENCE = 0.5;

export async function detectLetterhead(
  pages: RasterizedPage[],
  opts: LetterheadOptions = {},
): Promise<RegionResult | null> {
  if (pages.length === 0) {
    return { status: 'not_found', reason: 'no pages provided' };
  }

  const mode = opts.mode ?? 'default';
  if (mode === 'default') {
    return defaultCrop();
  }

  // 'smart' mode lands in the next subtask.
  return defaultCrop();
}

function defaultCrop(): RegionResult {
  return {
    status: 'detected',
    bbox: { x: 0, y: 0, w: 1, h: DEFAULT_CROP_Y_RATIO },
    detector: 'heuristic',
    confidence: DEFAULT_MODE_CONFIDENCE,
  };
}
