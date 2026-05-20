import { createCanvas } from '@napi-rs/canvas';
import type PdfjsLib from 'pdfjs-dist';
import type {
  PDFDocumentProxy,
  PDFPageProxy,
} from 'pdfjs-dist/types/src/display/api';

import { ExtractError } from '../extract/errors';

const DEFAULT_DPI = 200;
const DEFAULT_MAX_PAGES = 50;
const PDF_USER_SPACE_DPI = 72;

// Lazily resolved pdfjs reference. Loaded on first use via dynamic import to
// bypass Turbopack's static analysis which rewrites pdfjs-dist's internal
// module paths and breaks the worker resolver.
let _pdfjs: typeof PdfjsLib | null = null;

async function getPdfjs(): Promise<typeof PdfjsLib> {
  if (_pdfjs) return _pdfjs;
  // Dynamic import loads the module at runtime without Turbopack rewriting
  // the specifier. The legacy build is Node-safe (no DOM dependencies).
  _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // Point pdfjs at its worker for off-thread parsing. Turbopack rewrites
  // `require.resolve()` to a virtual path ("[project]/..."), so we build
  // the worker path from process.cwd() which always returns the real
  // filesystem project root.
  const workerPath = `${process.cwd()}/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`;
  _pdfjs.GlobalWorkerOptions.workerSrc = workerPath;
  return _pdfjs;
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
      throw new ExtractError(
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
): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfjs();
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

function translateLoadError(err: unknown): ExtractError {
  const name = err instanceof Error ? err.constructor.name : '';
  if (name === 'PasswordException') {
    return new ExtractError(
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
  return new ExtractError('MALFORMED_PDF', 'This PDF could not be parsed.', {
    cause: err,
  });
}

async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
): Promise<RasterizedPage> {
  const page: PDFPageProxy = await doc.getPage(pageNumber);
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
