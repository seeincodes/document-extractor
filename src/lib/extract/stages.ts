import { docxToPdf } from '../convert/libreoffice';
import { detectFooter } from '../detect/footer';
import { detectLetterhead } from '../detect/letterhead';
import { detectSignature } from '../detect/signature';
import { imageToPages } from '../rasterize/image';
import { rasterizePages } from '../rasterize/pdfjs';

import type { Stages } from './run';

export const defaultStages: Stages = {
  rasterize: (bytes) => rasterizePages(bytes),
  imageToPages: (bytes) => imageToPages(bytes),
  convertDocx: (bytes, tempDir) => docxToPdf(bytes, tempDir),
  detectLetterhead: (pages) => detectLetterhead(pages, { mode: 'smart' }),
  detectFooter: (pages) => detectFooter(pages, { mode: 'smart' }),
  detectSignature: (pages) => detectSignature(pages),
};
