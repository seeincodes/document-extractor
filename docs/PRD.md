# Product Requirements Document — Document Extractor

## Overview

A small web application that accepts a document upload (PDF, DOCX, PNG, JPEG) and extracts three specific regions — **signature**, **letterhead**, and **footer** — returning each as a downloadable PNG or JPEG image.

## Problem Statement

When humans review documents, they often care about three distinct regions: who sent it (letterhead), who signed it (signature), and any boilerplate at the bottom (footer). Pulling these regions out manually is tedious; doing it programmatically across heterogeneous document formats (born-digital PDFs, scanned PDFs, Word docs, images) is non-trivial because each format and each region has its own detection nuances. This project demonstrates an end-to-end pipeline that handles the heterogeneity, applies sensible heuristics per region, and presents results in a UI that communicates uncertainty clearly when a region cannot be detected.

## Target Users

The primary audience is the reviewers of the technical assessment — they evaluate code quality, product thinking, engineering decisions, and robustness. The secondary user persona is anyone who needs to pull canonical regions out of a document quickly without manual cropping (e.g., back-office staff handling letters, contracts, signed forms). Both personas care about the same things: the upload-to-download flow should be obvious, errors should be informative, and when a region is missing the UI should say so explicitly rather than returning a blank crop.

## MVP Requirements

- [MVP1] User can upload a document (PDF) via drag-and-drop or click-to-select on the home page
- [MVP2] Backend validates the upload (magic bytes, size ≤ 25MB, page count ≤ 50, not encrypted) and rejects unsupported types with `UNSUPPORTED_FILE_TYPE`
- [MVP3] User sees a preview of the uploaded PDF rendered in the browser
- [MVP4] Backend rasterizes each PDF page to a 200-DPI image in memory using `pdfjs-dist` + `@napi-rs/canvas`
- [MVP5] Backend extracts the **letterhead** region (top 18% of page 1, optionally refined by whitespace boundary detection) and returns it as a crop
- [MVP6] Backend extracts the **footer** region (bottom 12% of the last page) and returns it as a crop
- [MVP7] Backend extracts the **signature** region using a `sharp` + connected-components heuristic on the bottom 30% of the last page; returns the largest qualifying component as a crop
- [MVP8] If no signature is detected, the API returns `signature: null` with a reason, and the UI communicates "region not detected"
- [MVP9] User sees all three extracted regions rendered as preview images in the UI
- [MVP10] User can download each region as PNG (default) via a per-region download button
- [MVP11] Backend gracefully handles corrupt PDFs (`MALFORMED_PDF`), encrypted PDFs (`ENCRYPTED_PDF`), and files exceeding size/page limits with typed error codes and user-friendly messages
- [MVP12] App runs end-to-end with a single `docker compose up` command — reviewer needs no local Node/Python install
- [MVP13] Repo includes at least one sample PDF under `samples/` that exercises the full pipeline

## Final Submission Features

### Vision-model verification fallback
- [FS1] When the signature heuristic confidence is < 0.6, the candidate region is sent to Claude Sonnet vision for verification and bbox refinement
- [FS2] Per-request vision budget capped at $0.05; the API key is read from `ANTHROPIC_API_KEY` and the fallback is silently disabled when absent
- [FS3] UI displays a small badge per region indicating whether it was detected by the heuristic alone or verified by the vision model

### Additional input formats
- [FS4] DOCX upload supported via headless LibreOffice → PDF → existing pipeline
- [FS5] PNG and JPEG uploads supported, treated as single-page documents with the same detection logic applied directly
- [FS6] Tier-2 formats (DOC, RTF, ODT, WEBP, TIFF) accepted via the same toolchain, listed in README as "also accepted, not extensively tested"

### Scanned-document OCR
- [FS7] When a PDF page has near-empty extracted text but the rasterized image contains ink, the page is routed through Tesseract 5.x for OCR (used to inform footer detection on scans where text would otherwise be invisible to the boundary scanner)

### Adjustable crop UI
- [FS8] Each detected region renders inside a `react-easy-crop` widget pre-filled with the auto-detected bounding box; the user can drag/resize before downloading
- [FS9] The "Download" button re-requests the crop with the user-adjusted bounds in normalized coords

### Batch upload + ZIP download
- [FS10] The dropzone accepts up to 10 files per batch
- [FS11] Each file becomes its own job and renders as a row in a results table with per-doc status (queued, processing, done, failed)
- [FS12] A "Download all as ZIP" button packages every detected region from every successful doc as `batch-{timestamp}/{original-filename}/{region}.png`
- [FS13] Per-doc errors do not fail the batch; failed docs show their error inline while successful docs remain downloadable

### JPEG output and quality control
- [FS14] All region endpoints accept `?format=jpeg&quality=85` (or any 1–100 quality value) for smaller downloads

### Tests
- [FS15] Vitest unit tests for the signature heuristic against ~6 synthetic fixtures, the cropping math, and file-type validation
- [FS16] Vitest + supertest integration tests for `POST /api/extract` happy path and the main error paths (unsupported file, encrypted PDF, file too large)
- [FS17] One Playwright E2E test: upload sample PDF, wait for completion, verify all three preview images render, click download on signature

### Observability
- [FS18] `GET /api/health` returns `{ status, libreoffice: bool, tesseract: bool }`; Docker healthcheck wired up
- [FS19] Structured `pino` logs emit one line per stage transition with `requestId`, `stage`, `durationMs`, `detector`, `confidence` — no log of file contents

## Performance Targets

| Metric | Target | Notes |
|---|---|---|
| Time-to-first-region for a 1-page PDF | < 3 s on a modern laptop | Letterhead is the fastest; SSE streams it before signature finishes |
| End-to-end extraction for a 10-page PDF | < 15 s | Bounded by the unbounded sharp/pdfjs steps, not LibreOffice or Tesseract |
| Hard per-job timeout | 60 s | Job aborts with `TIMEOUT` error |
| Concurrent heavy jobs (LibreOffice, Tesseract) per process | 2 | In-process `p-queue` |
| Max queue depth | 10 | Beyond this `POST /api/extract` rejects with `503 SERVICE_BUSY` |
| Upload size limit | 25 MB | Enforced in the route handler |
| Page count limit | 50 / document | Rejected before rasterization |
| Batch size limit | 10 files | Enforced on the batch endpoint |
| Memory per rasterized A4 page | ~1.8 MB at 200 DPI | Bounds worst-case RAM usage |
| Vision fallback budget | $0.05 / request | ~16 page-region calls at Claude Sonnet pricing |

## Scope Boundaries

### In scope

- PDF, DOCX, PNG, JPEG inputs as first-class formats
- DOC, RTF, ODT, WEBP, TIFF inputs as best-effort (same toolchain, not heavily tested)
- Letterhead, footer, signature extraction
- PNG (default) and JPEG output with quality control
- Single-document and batch (≤10) upload flows
- Adjustable crop UI per region
- Vision-model verification as a fallback when the heuristic is uncertain
- OCR fallback for scanned PDFs
- Docker Compose single-command setup
- Stateless processing (no DB, no object storage, temp files only)
- Healthcheck endpoint, structured logging, typed error codes
- Vitest unit + integration tests and one Playwright E2E test

### Out of scope

- Authentication, accounts, rate limiting beyond the in-process queue
- Multi-tenant isolation, per-tenant cost controls
- Persisted job history (jobIds expire when the temp dir is swept)
- PPTX, XLSX, HTML, EPUB, Apple `.pages` inputs (explicitly rejected with a clear error)
- Languages other than English in OCR (`tesseract-ocr-eng` only)
- Production-scale concurrency (no Redis/BullMQ, no separate worker container)
- Telemetry to external services (no Sentry, no analytics)
- Persisted user data or analytics — filenames and sizes logged, contents not
- Mobile-specific UI optimizations beyond what Tailwind defaults give us
