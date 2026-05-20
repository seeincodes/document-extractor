import { detectLetterhead } from '../detect/letterhead';
import { rasterizePages } from '../rasterize/pdfjs';

import type { Stages } from './run';

// Production stages composition. Group 6 will replace detectFooter with a
// real implementation; group 7 will do the same for detectSignature.
// Until then, returning null is the correct "not yet detected" path — the
// orchestrator emits a region_ready event with status: 'not_found'.
export const defaultStages: Stages = {
  rasterize: (bytes) => rasterizePages(bytes),
  detectLetterhead: (pages) => detectLetterhead(pages, { mode: 'smart' }),
  detectFooter: async () => null,
  detectSignature: async () => null,
};
