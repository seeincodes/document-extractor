# Architecture Memo — Document Extractor

## Project Summary

A single Next.js (App Router) TypeScript application that accepts document uploads (PDF, DOCX, images), rasterizes them to 200-DPI PNG buffers, and applies per-region detection logic to extract letterhead, footer, and signature crops. The app is stateless — temp files live under `os.tmpdir()` for the lifetime of a request and are swept by a background process. Heavy processing (LibreOffice conversion, Tesseract OCR) is serialized through an in-process queue with a concurrency limit of 2; sharp and pdfjs run unbounded since they manage their own threading. The deliverable is a single `docker compose up` away from running, with no Node or Python required on the reviewer's machine.

## Key Architecture Decisions

### 1. Single Next.js App Router app, not a separate Express backend

**Why:** The brief explicitly evaluates engineering decisions. A monorepo with separate frontend and backend would buy us nothing for an assessment-scale app — both halves are TypeScript, both live in the same repo, both deploy as one container. App Router's `route.ts` files give us full Node.js access (including `sharp`, `pdfjs-dist`, and shelling out to `libreoffice`), and SSE-over-route-handlers is well-supported in modern Next. The cost of an Express layer would be duplicated tooling (two tsconfigs, two test runners, two lint configs) for no architectural benefit. The boundary that matters — pure business logic in `lib/` vs. thin route handlers in `app/api/` — is preserved regardless of framework.

**Rejected:** Express + Vite (two toolchains for no upside), Hono (less familiar to most reviewers, smaller community), monorepo with two packages (overkill for a 4–8 hour build).

### 2. `pdfjs-dist` + `@napi-rs/canvas` over `mupdf` for rasterization

**Why:** `mupdf` (Artifex WASM) is the fastest and highest-quality PDF renderer in the Node ecosystem, but it is AGPL-licensed. For a technical assessment we want freely shareable, the AGPL "network distribution" clause is a footgun that adds explanation overhead. `pdfjs-dist` is Apache-2.0, Mozilla-maintained, has ~3M weekly downloads, and pairs cleanly with `@napi-rs/canvas` (a prebuilt napi binding) on `node:20-slim`. We deliberately avoid Alpine because the musl prebuilds for `@napi-rs/canvas` have been historically unreliable; Debian-slim costs ~30MB more but eliminates a class of "works on my machine" bugs.

**Rejected:** `mupdf` (AGPL), `pdf2pic` (~50MB GraphicsMagick + Ghostscript + fragile shell args), `node-poppler` (extra system dep with no clear win over pdfjs), `unpdf` (same engine as pdfjs-dist with thinner ecosystem).

**Escape hatch:** if rasterization becomes a bottleneck on hundred-page PDFs, swap in `mupdf` behind the same `PageRasterizer` interface — no other code changes.

### 3. `sharp` + connected-components heuristic as the primary signature detector

**Why:** The brief weighs robustness and explicitly states "should not be the only mechanism" for any LLM/vision approach. We need our own logic that always runs. Native OpenCV (`@u4/opencv4nodejs`) would give 75–85% accuracy but ships ~400MB of Docker bloat for marginal value over what `sharp` can do. `sharp` is already in the stack for cropping, and a connected-components flood-fill in TypeScript is ~200 LOC — small enough to read in review, large enough to demonstrate engineering depth. The heuristic produces a confidence score (size, isolation, stroke-width variance) and only when confidence falls below 0.6 do we send the candidate region to Claude vision for verification. This satisfies the "not the only mechanism" rule while still giving us 90%+ accuracy on the cases that matter.

**Rejected:** Native OpenCV (Docker bloat, build complexity), `opencv.js` (~8MB WASM and a larger API surface for not much win), pretrained ONNX signature models (sourcing and validating a maintained model would eat the entire time budget), Claude-vision-only (violates the brief's "not the only mechanism" rule).

### 4. Headless LibreOffice for DOCX → PDF, reuse PDF pipeline

**Why:** Once we have a PDF rasterization pipeline, the cheapest way to add DOCX support is to convert DOCX → PDF and reuse everything downstream. This means zero new image-processing code. The trade-off is one new system binary (`libreoffice-core`, ~400MB to the Docker image, single-threaded per process). The win is that the same binary also unlocks DOC, RTF, ODT, PPTX, XLSX — useful future-proofing. `mammoth` is tempting because it's pure-JS, but it converts DOCX → HTML, which has no concept of pages. We'd then need Chromium to re-paginate the HTML to find a "footer of every page," which is a heavier toolchain than LibreOffice and gives worse fidelity. The concurrency limit of 2 in the in-process queue prevents LibreOffice's single-threaded-per-process limitation from being a footgun.

**Rejected:** `mammoth` (loses pagination, eventually needs Chromium anyway), `docx-preview` (fragile on complex docs), pure-JS DOCX→image (no mature option in 2026).

### 5. SSE for progress updates, not WebSocket or polling

**Why:** The brief weighs UX heavily. Polling `GET /api/extract/:jobId` every 500ms wastes server cycles and feels laggy. WebSocket is bi-directional, but we only need server→client — a one-way SSE stream is simpler, requires no extra library, and survives proxies/load balancers more gracefully. The streamed event shape is `{ stage, progress, partial? }`, where `partial` can include a region-ready event so the UI can render the letterhead while the signature is still detecting. SSE works natively over HTTP/1.1 and HTTP/2, and Next App Router's `route.ts` supports it via `ReadableStream`.

**Rejected:** Polling (worse UX, more server load), WebSocket (extra moving part for one-way data), single long-running POST (user can't start downloading region A while region C is still processing).

### 6. Stateless — no DB, no object storage

**Why:** The brief says nothing about persistence; jobIds only need to outlive their request. Adding Postgres or S3 (or even SQLite) would balloon the Docker image and complicate the "single command to start" deliverable. The jobId points to an in-memory `Map<string, JobRecord>` per process; the entry expires when the temp dir is swept (10-minute background job). The interface around the job store (`JobStore.create`, `JobStore.get`, `JobStore.update`) is what matters — when we eventually need persistence (production-scale, multi-tenant), the in-memory implementation swaps for a Postgres-backed one with no API code changes.

**Rejected:** Postgres + Prisma (overkill for assessment), SQLite (small but unjustified for a stateless service), Redis (helpful only at multi-process scale).

### 7. In-process queue with concurrency 2, not BullMQ + Redis

**Why:** LibreOffice and Tesseract are CPU-heavy and benefit from serialization to avoid thrashing on a single-core dev machine. The queue ceiling of 2 (not 1) lets one in-flight job make progress while another is starting. A separate worker process behind Redis/BullMQ would be the right answer for production scale, but for an assessment app it's overkill — it doubles the container count, adds Redis as a dependency, and obscures the actual extraction logic with infrastructure code. The interface that wraps the queue (a simple `enqueue<T>(task: () => Promise<T>): Promise<T>`) abstracts the implementation, so we can extract to a separate worker container later with no API code changes.

**Rejected:** BullMQ + Redis (assessment-scale overkill), per-request worker thread (cold-start cost, harder to debug), unbounded concurrency (single-core dev box would thrash under DOCX + OCR load).

## Processing Strategy

The pipeline is composed as a series of pure functions in `lib/`, orchestrated by a thin route handler in `app/api/extract/route.ts`. Each stage emits an SSE event so the UI can render progress and partials.

```
Upload (multipart/form-data)
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 1: VALIDATE                                                   │
│  - magic-byte sniff via `file-type` (not extension)                 │
│  - size ≤ 25MB, batch ≤ 10                                          │
│  - on failure → UNSUPPORTED_FILE_TYPE, encode → 400                 │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 2: NORMALIZE (per input type)                                 │
│  - PDF → straight to rasterize                                      │
│  - DOCX/DOC/RTF/ODT → LibreOffice → PDF → rasterize                 │
│      (enqueued via p-queue, concurrency 2)                          │
│  - PNG/JPEG/WEBP/TIFF → treat as single-page PDF-equivalent         │
│  - On encrypted PDF → ENCRYPTED_PDF; malformed → MALFORMED_PDF      │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 3: RASTERIZE                                                  │
│  - pdfjs-dist parses, @napi-rs/canvas renders each page at 200 DPI  │
│  - greyscale buffer for detection, color buffer for final crop      │
│  - page cap 50; over → PAGE_LIMIT_EXCEEDED                          │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼ (parallel for all three regions)
┌───────────────────────┬───────────────────────┬─────────────────────┐
│ Stage 4a: LETTERHEAD  │ Stage 4b: FOOTER      │ Stage 4c: SIGNATURE │
│  - top 18% page 1     │  - bottom 12% last pg │  - bottom 30% last  │
│  - optional whitespace│  - optional whitespace│  - sharp threshold  │
│    boundary scan      │    boundary scan      │  - connected comps  │
│  - emit ready event   │  - emit ready event   │  - confidence score │
│                       │                       │  - if < 0.6 → vision│
│                       │                       │     fallback        │
│                       │                       │  - emit ready event │
└───────────────────────┴───────────────────────┴─────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 5: ENCODE & STORE                                             │
│  - crops materialized as PNG in temp dir, indexed by jobId+region   │
│  - JobStore.update({ status: 'done', regions: {...} })              │
│  - SSE emits final `done` event with region URLs                    │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
Downloads served from `GET /api/extract/:jobId/region/:name`
ZIP served from `GET /api/extract/:jobId/zip`
Temp dirs swept by background timer (10-min TTL)
```

Module layout:

- `lib/extract/` — pipeline orchestrator, JobStore, SSE event types
- `lib/rasterize/` — `PageRasterizer` interface; `pdfjs` implementation
- `lib/detect/` — `letterhead.ts`, `footer.ts`, `signature.ts` (each exports a pure function `detect(pages, opts) → BBox | null`)
- `lib/convert/` — `libreoffice.ts` for DOCX→PDF, plumbed through the queue
- `lib/ocr/` — `tesseract.ts`, only invoked when text extraction is empty
- `lib/vision/` — `claude.ts`, signature-bbox refinement; budget-aware
- `lib/queue/` — `p-queue` wrapper exposing `enqueue<T>(task)`
- `lib/io/` — temp-dir lifecycle, file-type sniffing, magic-byte validation

Route handlers in `app/api/` are thin: parse multipart, call the orchestrator, stream events. No business logic in route files.

## Known Failure Modes

### Detection-quality failures

- **No signature detected** — return `signature: null` with `reason: "no candidate region met confidence threshold"`. UI shows an explicit "no signature found" badge with a tooltip explaining the heuristic. The brief explicitly requires this behavior.
- **False-positive signature on text-heavy document** — the stroke-variance filter is the primary defense. If a heavy-handed handwritten title in the bottom 30% trips the heuristic, the vision fallback (when available) will correct it; without the fallback, the user can adjust the crop in the UI.
- **Letterhead missed on a centered-logo document** — the 18% top default may catch only part of a tall logo. The whitespace boundary scan helps here, falling back to 18% if no boundary is found. User can also adjust via the crop UI.
- **Footer detected on the wrong page** — we default to "last page only" with a note "same region appears on N total pages." Users wanting per-page footers use the adjustable crop UI to override.

### Format / parsing failures

- **Encrypted PDF** — `pdfjs.getDocument()` rejects with a known error type → surface as `ENCRYPTED_PDF` with message "we don't support password-protected PDFs."
- **Truncated or malformed PDF** — wrap parsing in try/catch → `MALFORMED_PDF` with underlying parser error in server logs only (not exposed to user, since parser errors can leak file structure).
- **DOCX that LibreOffice can't open** — `soffice --convert-to pdf` returns a non-zero exit; capture stderr, log, return `CONVERSION_FAILED`.
- **PDF with JavaScript** — `isEvalSupported: false` in pdfjs config; PDFs with script blocks parse without executing them.

### Resource / budget failures

- **File > 25MB** — rejected at the route handler before any processing → `FILE_TOO_LARGE`.
- **Page count > 50** — detected after parsing but before rasterization → `PAGE_LIMIT_EXCEEDED`.
- **Per-job 60s timeout** — race between pipeline and timer; if timer wins, the job is aborted, temp files cleaned, and the SSE stream emits `TIMEOUT`.
- **Queue depth > 10** — `POST /api/extract` returns 503 `SERVICE_BUSY` with a `Retry-After` header.
- **Vision budget exhausted mid-job** — emit a region-level `unverified: true` flag for subsequent low-confidence regions instead of failing the whole job.
- **`ANTHROPIC_API_KEY` missing or invalid** — vision fallback silently disables; the UI surfaces a hint ("low-confidence detection — provide an API key for verification") rather than an error.
- **`tesseract` or `libreoffice` binary missing in container** — `/api/health` reports false for the missing tool; relevant code paths short-circuit with `TOOL_UNAVAILABLE`. Should never happen in the official Docker image, but the healthcheck catches it.

### Security / hardening failures

- **`.exe` masquerading as `.pdf`** — magic-byte validation rejects with `UNSUPPORTED_FILE_TYPE` before any parser touches the bytes.
- **Decompression bomb / billion-laughs** — bounded by the 25MB size limit, 50-page cap, and 60s timeout. `pdfjs` itself has internal limits on object counts.
- **LibreOffice escapes its temp directory** — run as a non-root user with `--norestore --nolockcheck --nodefault --nofirststartwizard` in a per-request temp dir. The Docker container itself has no network egress except the explicit Anthropic API call.
- **Temp files leak on crash** — background sweeper runs every 5 minutes, deleting directories older than 10 minutes. The `finally` block in the pipeline catches the happy path; the sweeper catches the crash path.

### Operational failures

- **Process restart during a job** — in-memory JobStore loses the entry; the SSE stream closes with a network error; the frontend retries the upload. Acceptable for an assessment app; production would persist jobs.
- **Disk full on temp partition** — surface as `TEMP_STORAGE_FULL`; the healthcheck reports degraded if free space < 100MB.
