import { detectFooter } from '../detect/footer';
import { detectLetterhead } from '../detect/letterhead';
import { detectSignature } from '../detect/signature';
import { rasterizePages } from '../rasterize/pdfjs';

import type { Stages } from './run';

// Production stages composition. The Stages interface passes a jobId to
// each detector; detectSignature ignores it (the signature heuristic has
// no per-job state), so the adapter discards it explicitly.
export const defaultStages: Stages = {
  rasterize: (bytes) => rasterizePages(bytes),
  detectLetterhead: (pages) => detectLetterhead(pages, { mode: 'smart' }),
  detectFooter: (pages) => detectFooter(pages, { mode: 'smart' }),
  detectSignature: (pages) => detectSignature(pages),
};
