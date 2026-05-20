# Technology Stack — Document Extractor

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Browser (Next.js client)                    │
│                                                                      │
│   react-dropzone ──► PDF preview (react-pdf) ──► result table        │
│         │                                            ▲               │
│         │ multipart POST                             │ SSE events    │
│         ▼                                            │               │
└─────────┼────────────────────────────────────────────┼───────────────┘
          │                                            │
          │   HTTP                                     │   text/event-stream
          ▼                                            │
┌──────────────────────────────────────────────────────┴───────────────┐
│           Next.js App Router server (Node 20 runtime)                │
│                                                                      │
│   app/api/extract/route.ts (thin)                                    │
│         │                                                            │
│         ▼                                                            │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │ lib/extract/  orchestrator (pure-function pipeline)          │   │
│   │     │                                                        │   │
│   │     ├──► lib/io/  magic-byte sniff (file-type)               │   │
│   │     │                                                        │   │
│   │     ├──► lib/convert/  LibreOffice DOCX→PDF (queued, conc 2) │   │
│   │     │       │                                                │   │
│   │     │       ▼ (shells out)                                   │   │
│   │     │   soffice --convert-to pdf                             │   │
│   │     │                                                        │   │
│   │     ├──► lib/rasterize/  pdfjs-dist + @napi-rs/canvas        │   │
│   │     │                    (200 DPI, greyscale + color)        │   │
│   │     │                                                        │   │
│   │     ├──► lib/detect/letterhead.ts   (top 18% scan)           │   │
│   │     ├──► lib/detect/footer.ts       (bottom 12% scan)        │   │
│   │     ├──► lib/detect/signature.ts    (sharp + components)     │   │
│   │     │       │                                                │   │
│   │     │       ▼ (confidence < 0.6)                             │   │
│   │     │   lib/vision/claude.ts  (Anthropic SDK)  ◄── only      │   │
│   │     │                                              external  │   │
│   │     │                                              network   │   │
│   │     │                                              egress    │   │
│   │     ├──► lib/ocr/  tesseract (queued, conc 2)                │   │
│   │     │       │                                                │   │
│   │     │       ▼ (shells out)                                   │   │
│   │     │   tesseract <image> stdout                             │   │
│   │     │                                                        │   │
│   │     └──► lib/queue/  p-queue (concurrency 2 for heavy steps) │   │
│   │                                                              │   │
│   └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│   In-memory JobStore  ◄── jobIds                                     │
│   Temp dir /tmp/extractor-<requestId>/  ◄── crops on disk            │
│   Background sweeper (every 5 min, deletes > 10 min old)             │
└──────────────────────────────────────────────────────────────────────┘
          │
          │ structured logs (pino)
          ▼
       stdout (Docker captures)
```

## Stack Decisions

| Layer                    | Technology                                | Version   | Rationale                                                                                      |
| ------------------------ | ----------------------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| Language (both ends)     | TypeScript                                | 5.x       | Required by the brief; strict mode + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| Framework                | Next.js (App Router)                      | 15.x      | One repo, one toolchain; route.ts gives full Node access; SSE supported                        |
| Node runtime             | Node                                      | 20 LTS    | LTS through 2026; `@napi-rs/canvas` has stable prebuilds; native `fetch` available             |
| UI library               | React                                     | 19.x      | Pinned to Next.js's vendored version                                                           |
| Styling                  | Tailwind CSS                              | 4.x       | Standard, fast to assemble; reviewers expect it                                                |
| Component primitives     | shadcn/ui                                 | latest    | Button, Card, Dialog, Progress, Alert, Tabs — composable, owned-in-repo                        |
| File upload UI           | react-dropzone                            | 14.x      | Drag-drop + click-select + type filtering in one component                                     |
| PDF preview              | react-pdf                                 | 9.x       | Wraps pdfjs in React; renders pages with sensible defaults                                     |
| Crop UI                  | react-easy-crop                           | 5.x       | Pre-fill from auto-detected bbox; normalized coords map cleanly to backend                     |
| PDF rasterization        | pdfjs-dist                                | 4.x       | Apache-2.0, Mozilla-maintained; chosen over AGPL `mupdf`                                       |
| Canvas backend           | @napi-rs/canvas                           | 0.x       | Prebuilt napi binding; pairs cleanly with pdfjs in Node                                        |
| Image processing         | sharp                                     | 0.33+     | Crop, resize, threshold, encode PNG/JPEG; libvips under the hood                               |
| File type sniffing       | file-type                                 | 19.x      | Magic-byte detection (never trust extension)                                                   |
| Queue                    | p-queue                                   | 8.x       | Tiny, well-tested; concurrency limit for heavy steps                                           |
| Logger                   | pino                                      | 9.x       | Structured JSON logs, fast                                                                     |
| Archiver                 | archiver                                  | 7.x       | ZIP packaging for batch / per-doc download                                                     |
| Vision API               | @anthropic-ai/sdk                         | latest    | Signature bbox refinement fallback; Claude Sonnet vision                                       |
| DOCX→PDF                 | LibreOffice (`soffice`)                   | system    | One binary unlocks DOCX, DOC, RTF, ODT, PPTX, XLSX                                             |
| OCR                      | node-tesseract-ocr + system Tesseract 5.x | latest    | Native is faster than WASM; only one apt package                                               |
| Unit / integration tests | Vitest                                    | 2.x       | Fast, ESM-first, drops into Next.js stack cleanly                                              |
| HTTP test helper         | supertest                                 | 7.x       | For integration tests against route handlers                                                   |
| E2E test                 | Playwright                                | 1.x       | One smoke test for the upload-to-download flow                                                 |
| Linter                   | ESLint + @typescript-eslint               | 9.x / 8.x | Standard Next.js config as base, then tightened                                                |
| Formatter                | Prettier                                  | 3.x       | Committed config; no formatting debates                                                        |
| Container base           | node:20-slim (Debian)                     | —         | Avoids Alpine musl issues with @napi-rs/canvas                                                 |
| Container orchestration  | Docker Compose                            | v2        | Single command (`docker compose up`) per the brief                                             |

## Key Dependencies

### Backend (production)

- `next` — App Router framework
- `react`, `react-dom` — required peer of Next
- `sharp` — image cropping, threshold, encoding
- `pdfjs-dist` — PDF parsing and page rendering
- `@napi-rs/canvas` — canvas backend for pdfjs in Node
- `file-type` — magic-byte file-type detection
- `p-queue` — bounded concurrency wrapper for LibreOffice and Tesseract
- `pino` — structured logging
- `archiver` — ZIP packaging for downloads
- `node-tesseract-ocr` — Node wrapper around system Tesseract
- `libreoffice-convert` _(or a thin shell wrapper)_ — DOCX→PDF via system `soffice`
- `@anthropic-ai/sdk` — Claude vision fallback for signature verification

### Frontend (production)

- `tailwindcss` — utility-first styling
- `@tailwindcss/postcss` — Tailwind v4 PostCSS plugin
- shadcn/ui dependencies — `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, Radix primitives (`@radix-ui/react-*`) as each shadcn component requires
- `react-dropzone` — drag-and-drop file upload
- `react-pdf` — in-browser PDF preview
- `react-easy-crop` — adjustable crop UI per region

### Dev / test

- `typescript` — language toolchain
- `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `eslint-plugin-react`, `eslint-plugin-react-hooks`, `eslint-config-next` — linting
- `prettier` — formatting
- `vitest`, `@vitest/coverage-v8` — unit + integration tests
- `supertest` — HTTP test helper for route handlers
- `@playwright/test`, `playwright` — E2E

### System (in Docker image, installed via apt)

- `libreoffice-core` — DOCX, DOC, RTF, ODT → PDF
- `tesseract-ocr`, `tesseract-ocr-eng` — OCR engine + English language data
- `libfontconfig1`, `libpixman-1-0`, `libcairo2` — `@napi-rs/canvas` runtime deps

## Environment Variables

Template lives at `.env.example` in repo root; users copy to `.env`. All variables are optional except where noted.

```bash
# ── Anthropic vision fallback (optional) ─────────────────────────────
# If absent, the signature heuristic runs without a vision-model second
# pass. Confidence below 0.6 will surface as "unverified" in the UI.
ANTHROPIC_API_KEY=

# Maximum dollar budget per request for vision fallback calls.
# Defaults to 0.05 (~16 Claude Sonnet vision calls).
VISION_BUDGET_USD_PER_REQUEST=0.05

# Claude model used for signature verification. Sonnet is the default.
VISION_MODEL=claude-sonnet-4-6

# ── Processing limits ────────────────────────────────────────────────
# Hard upload size limit in bytes (default 25MB).
MAX_UPLOAD_BYTES=26214400

# Hard page count limit per document (default 50).
MAX_PAGES=50

# Hard batch size limit (default 10).
MAX_BATCH_FILES=10

# Hard per-job timeout in seconds (default 60).
JOB_TIMEOUT_SECONDS=60

# Concurrency for heavy operations (LibreOffice, Tesseract).
# Default 2; raise carefully on multi-core machines.
HEAVY_CONCURRENCY=2

# Maximum queue depth before 503 SERVICE_BUSY is returned.
MAX_QUEUE_DEPTH=10

# Rasterization DPI. 200 is the sweet spot.
RASTER_DPI=200

# ── Temp file lifecycle ──────────────────────────────────────────────
# Per-request temp dirs live under this prefix.
# Defaults to the OS temp dir; override for tests.
TEMP_DIR=

# How often the background sweeper runs (seconds).
SWEEP_INTERVAL_SECONDS=300

# Temp dirs older than this are deleted by the sweeper (seconds).
TEMP_TTL_SECONDS=600

# ── Logging ──────────────────────────────────────────────────────────
# pino log level: trace | debug | info | warn | error | fatal
LOG_LEVEL=info

# ── Next.js / Node ───────────────────────────────────────────────────
# Set by Next at build/run; documented here for completeness.
NODE_ENV=development
```

## Database Schema

_Not applicable._ The application is stateless. There is no database; the runtime job store is an in-memory `Map<string, JobRecord>` and persistence beyond the request lifetime is explicitly out of scope.

JobRecord shape (purely for runtime memory, not persisted):

```ts
type JobStage =
  | 'queued'
  | 'validating'
  | 'normalizing'
  | 'rasterizing'
  | 'detecting_letterhead'
  | 'detecting_footer'
  | 'detecting_signature'
  | 'done'
  | 'failed';

type RegionResult =
  | {
      status: 'detected';
      bbox: NormalizedBBox;
      pngPath: string;
      detector: 'heuristic' | 'vision';
      confidence: number;
    }
  | { status: 'not_found'; reason: string }
  | {
      status: 'unverified';
      bbox: NormalizedBBox;
      pngPath: string;
      detector: 'heuristic';
      confidence: number;
      reason: string;
    };

interface JobRecord {
  jobId: string;
  batchId?: string;
  originalFilename: string;
  receivedAt: number;
  stage: JobStage;
  tempDir: string;
  regions: {
    letterhead?: RegionResult;
    footer?: RegionResult;
    signature?: RegionResult;
  };
  error?: { code: string; message: string };
}
```

## API Endpoints Summary

| Method | Path                               | Purpose                                                                                                                      |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/extract`                     | Upload one document (multipart); returns `{ jobId }` immediately and begins processing                                       |
| `GET`  | `/api/extract/:jobId/stream`       | SSE; streams stage transitions and per-region ready events until `done` or `failed`                                          |
| `GET`  | `/api/extract/:jobId/region/:name` | Returns the cropped image (`name` ∈ `letterhead \| footer \| signature`). Accepts `?format=png\|jpeg&quality=N` query params |
| `GET`  | `/api/extract/:jobId/zip`          | Returns all detected regions for a single doc as one ZIP                                                                     |
| `POST` | `/api/extract/:jobId/recrop/:name` | Accepts a user-adjusted normalized bbox, recrops, returns the new PNG (used by the adjustable crop UI)                       |
| `POST` | `/api/extract/batch`               | Upload up to 10 docs (multipart); returns `{ batchId, jobIds[] }`. Each job streams independently                            |
| `GET`  | `/api/extract/batch/:batchId/zip`  | Returns all regions from all completed jobs in the batch, organized as `{original-filename}/{region}.png`                    |
| `GET`  | `/api/health`                      | Returns `{ status, libreoffice: bool, tesseract: bool, freeDiskMB: number }` for the Docker healthcheck                      |
