import { createRequire } from 'node:module';

import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const DEFAULT_DPI = 200;
const DEFAULT_MAX_PAGES = 50;
const PDF_USER_SPACE_DPI = 72;

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = require.resolve(
  'pdfjs-dist/legacy/build/pdf.worker.mjs',
);

export type RasterizeErrorCode =
  | 'ENCRYPTED_PDF'
  | 'MALFORMED_PDF'
  | 'PAGE_LIMIT_EXCEEDED';

export class RasterizeError extends Error {
  override name = 'RasterizeError' as const;
  constructor(
    readonly code: RasterizeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface RasterizedPage {
  width: number;
  height: number;
  color: Uint8ClampedArray;
  greyscale: Uint8ClampedArray;
}

export interface RasterizeOptions {
  dpi?: number;
  maxPages?: number;
}

export async function rasterizePages(
  data: Uint8Array,
  opts: RasterizeOptions = {},
): Promise<RasterizedPage[]> {
  const dpi = opts.dpi ?? DEFAULT_DPI;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const scale = dpi / PDF_USER_SPACE_DPI;

  const doc = await loadDocument(data);

  try {
    if (doc.numPages > maxPages) {
      throw new RasterizeError(
        'PAGE_LIMIT_EXCEEDED',
        `Document has ${doc.numPages} pages; the limit is ${maxPages}.`,
      );
    }

    const pages: RasterizedPage[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      pages.push(await renderPage(doc, pageNumber, scale));
    }
    return pages;
  } finally {
    await doc.cleanup();
    await doc.destroy();
  }
}

async function loadDocument(
  data: Uint8Array,
): Promise<pdfjs.PDFDocumentProxy> {
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    return await loadingTask.promise;
  } catch (err) {
    throw translateLoadError(err);
  }
}

function translateLoadError(err: unknown): RasterizeError {
  const name = err instanceof Error ? err.constructor.name : '';
  if (name === 'PasswordException') {
    return new RasterizeError(
      'ENCRYPTED_PDF',
      'This PDF is password-protected.',
      { cause: err },
    );
  }
  // Any other parse-time failure (InvalidPDFException, MissingPDFException,
  // UnknownErrorException, etc.) is surfaced as MALFORMED_PDF. The original
  // error is preserved in `cause` for server-side logs; the user message is
  // intentionally generic per docs/MEMO.md ("parser errors can leak file
  // structure").
  return new RasterizeError('MALFORMED_PDF', 'This PDF could not be parsed.', {
    cause: err,
  });
}

async function renderPage(
  doc: pdfjs.PDFDocumentProxy,
  pageNumber: number,
  scale: number,
): Promise<RasterizedPage> {
  const page = await doc.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale });
    const width = Math.floor(viewport.width);
    const height = Math.floor(viewport.height);

    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);

    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;

    const color = new Uint8ClampedArray(
      context.getImageData(0, 0, width, height).data,
    );
    const greyscale = toGreyscale(color, width, height);

    return { width, height, color, greyscale };
  } finally {
    page.cleanup();
  }
}

function toGreyscale(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  // ITU-R BT.601 luma: cheap, well-understood, fine for the threshold-based
  // detectors that consume this output. A future swap to sharp() is possible
  // behind the same return shape if benchmarks warrant.
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    // `?? 0` is a noop at runtime (rgba is fully populated by the caller)
    // but quiets noUncheckedIndexedAccess without a non-null assertion.
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    out[j] = (r * 299 + g * 587 + b * 114 + 500) / 1000;
  }
  return out;
}
