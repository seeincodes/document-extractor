# Document Extractor

Upload a document and automatically extract its **letterhead**, **footer**, and **signature** regions. Built with Next.js (App Router) and TypeScript.

## Prerequisites

- **Node.js 20 LTS** (20.x)
- npm 10+

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment template
cp .env.example .env.local

# 3. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Docker

```bash
docker compose up
```

The app is served on port 3000 with a health check at `/api/health`.

## Architecture

```
src/
├── app/                    # Next.js App Router pages + API routes
│   ├── api/
│   │   ├── extract/        # POST upload, GET SSE stream, GET region PNG
│   │   │   ├── route.ts              # POST /api/extract — upload
│   │   │   ├── [jobId]/stream/       # GET — SSE progress stream
│   │   │   ├── [jobId]/region/[name] # GET — region crop (PNG/JPEG)
│   │   │   ├── [jobId]/recrop/[name] # POST — re-crop with custom bbox
│   │   │   ├── [jobId]/zip/          # GET — download all regions as ZIP
│   │   │   └── batch/                # POST — batch upload (up to 10 files)
│   │   └── health/         # GET /api/health — liveness probe
│   └── page.tsx            # Home page (upload zone + results)
├── components/             # React UI components
├── lib/
│   ├── convert/            # DOCX → PDF via headless LibreOffice
│   ├── detect/             # Region detectors (letterhead, footer, signature)
│   ├── extract/            # Orchestrator, job store, SSE, crop, errors
│   ├── io/                 # File validation (magic bytes), temp dirs
│   ├── ocr/                # Tesseract OCR wrapper
│   ├── queue/              # p-queue concurrency limiter
│   ├── rasterize/          # PDF → pages (pdfjs-dist) + image → pages (sharp)
│   └── vision/             # Claude vision fallback for signature verification
└── ...
```

### Key Design Decisions

- **Stateless**: no database, no object storage. Temp files are swept every 5 minutes.
- **Magic-byte validation**: file types are detected by magic bytes via `file-type`, never by extension.
- **Signature detection**: connected-components heuristic first, Claude Sonnet vision fallback when confidence < 0.6.
- **In-process queue**: `p-queue` with concurrency 2 for heavy operations (LibreOffice, Tesseract).
- **SSE streaming**: real-time progress updates via Server-Sent Events.

## Supported File Types

| Type | Extension | Detection |
|------|-----------|-----------|
| PDF  | `.pdf`    | Rasterized via pdfjs-dist + @napi-rs/canvas |
| DOCX | `.docx`   | Converted to PDF via headless LibreOffice |
| PNG  | `.png`    | Processed directly via sharp |
| JPEG | `.jpg/.jpeg` | Processed directly via sharp |
| TIFF | `.tiff/.tif`  | Processed directly via sharp |
| WebP | `.webp`   | Processed directly via sharp |

**Limits**: 25 MB max upload, 50 pages max (PDF), 10 files max (batch).

## Extracted Regions

| Region     | Source     | Crop Area |
|-----------|------------|-----------|
| Letterhead | Page 1     | Top 18% (smart boundary scan) |
| Footer     | Last page  | Bottom 12% (smart boundary scan) |
| Signature  | All pages (reverse scan) | Full page (connected-components heuristic) |

## Environment Variables

Copy `.env.example` to `.env.local`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Required for vision fallback |
| `VISION_BUDGET_USD_PER_REQUEST` | `0.05` | Max vision API spend per request |
| `MAX_UPLOAD_BYTES` | `26214400` | 25 MB |
| `MAX_PAGES` | `50` | Max PDF pages |
| `MAX_BATCH_FILES` | `10` | Max files per batch |
| `JOB_TIMEOUT_SECONDS` | `60` | Per-job timeout |
| `HEAVY_CONCURRENCY` | `2` | LibreOffice/Tesseract queue concurrency |
| `LOG_LEVEL` | `info` | Pino log level |

See `.env.example` for the full list.

## Testing

```bash
# Unit + integration tests (Vitest)
npm test

# E2E tests (Playwright)
npx playwright test
```

## Sample Documents

The `samples/` directory contains synthetic fixture documents:

- `clean-letter.pdf` — single-page letter with all regions
- `tall-letterhead.pdf` — letterhead extending below the 18% default
- `no-letterhead.pdf` — negative case (no distinct letterhead)
- `multi-page-report.pdf` — 3-page report with letterhead, signature, footer

See `samples/README.md` for details.

## Limitations

- **No persistence**: all data is lost on restart. This is by design.
- **Single-process**: no external queue or broker. Heavy operations (LibreOffice, Tesseract) are limited to 2 concurrent tasks.
- **Vision fallback requires API key**: without `ANTHROPIC_API_KEY`, low-confidence signatures use heuristic results only.
- **DOCX conversion requires LibreOffice**: the `soffice` binary must be available on PATH.
- **OCR requires Tesseract**: the `tesseract` binary must be available on PATH.

## Assumptions

- Documents contain at most one letterhead, footer, and signature each.
- Letterhead is in the top portion of page 1.
- Footer is in the bottom portion of the last page.
- Signature is scanned across all pages (reverse order, last page first). The best candidate across all pages is selected.
- The signature heuristic looks for connected components that are wider than tall (1.5:1 to 25:1 aspect ratio) with a sparse fill ratio (≤ 12%) to reject dense text blocks.
