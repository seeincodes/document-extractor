import { detectFooter } from '../detect/footer';
import { detectLetterhead } from '../detect/letterhead';
import { rasterizePages } from '../rasterize/pdfjs';

import type { Stages } from './run';

// Production stages composition. Group 7 will replace detectSignature with a
// real implementation. Until then, returning null is the correct "not yet
// detected" path — the orchestrator emits a region_ready event with
// status: 'not_found'.
export const defaultStages: Stages = {
  rasterize: (bytes) => rasterizePages(bytes),
  detectLetterhead: (pages) => detectLetterhead(pages, { mode: 'smart' }),
  detectFooter: (pages) => detectFooter(pages, { mode: 'smart' }),
  detectSignature: async () => null,
};
