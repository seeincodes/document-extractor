# Task List — Document Extractor

Tasks are phased: **Phase 1 (MVP)** delivers the brief's required scope and is the minimum bar for submission. **Phase 2 (Polish)** adds nice-to-haves and UX refinements. **Phase 3 (Final)** is the pre-submission pass — tests, Docker, README, sample documents, commit hygiene.

Each task group references the PRD requirement IDs it satisfies. Subtask checklists are tracked here; completion is marked `- [x]` when the work is merged.

---

## Phase 1: MVP

### 1. Project scaffold and tooling

_Satisfies: prerequisite for everything_

- [x] Initialize Next.js 15 App Router app with TypeScript template
- [x] Configure `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`
- [x] Configure ESLint (`@typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-react-hooks`) and Prettier with project config
- [x] Add `npm run typecheck` (`tsc --noEmit`), `npm run lint`, `npm run format` scripts
- [ ] Create empty `lib/extract/`, `lib/rasterize/`, `lib/detect/`, `lib/convert/`, `lib/ocr/`, `lib/vision/`, `lib/queue/`, `lib/io/` directories with `.gitkeep`
- [ ] Add Tailwind CSS v4 + PostCSS configuration; verify a styled component renders
- [ ] Initialize shadcn/ui and install Button, Card, Dialog, Progress, Alert, Tabs primitives
- [ ] Commit: `chore: scaffold next.js app and tooling`

### 2. PDF rasterization

_Satisfies: [MVP4]_

- [ ] Install `pdfjs-dist` and `@napi-rs/canvas`
- [ ] Implement `lib/rasterize/pdfjs.ts` exporting `PageRasterizer` interface and `rasterizePages(buffer, opts)` returning per-page color + greyscale buffers at 200 DPI
- [ ] Configure pdfjs `GlobalWorkerOptions.workerSrc` correctly for the Node runtime; disable `isEvalSupported`
- [ ] Handle encrypted PDF (`PasswordException`) → throw typed `ENCRYPTED_PDF` error
- [ ] Handle malformed PDF (parse errors) → throw typed `MALFORMED_PDF` error
- [ ] Enforce 50-page cap; throw `PAGE_LIMIT_EXCEEDED` before rasterizing if exceeded
- [ ] Commit: `feat(rasterize): pdf to 200-dpi image buffers`

### 3. File validation and upload route

_Satisfies: [MVP1], [MVP2], [MVP11]_

- [ ] Install `file-type`
- [ ] Implement `lib/io/validate.ts` with magic-byte detection for PDF, DOCX, PNG, JPEG (and TIFF/WEBP as tier-2)
- [ ] Implement `lib/io/tempDir.ts` with `createJobTempDir(jobId)` and `cleanupTempDir(jobId)` helpers
- [ ] Implement `lib/extract/jobStore.ts` with in-memory `Map<jobId, JobRecord>` and the JobRecord shape from `docs/TECH_STACK.md`
- [ ] Implement `lib/extract/errors.ts` with the typed error code constants and a `toUserMessage(code)` helper
- [ ] Implement `app/api/extract/route.ts` (POST): parse multipart, validate, write upload to temp dir, create JobRecord, return `{ jobId }` with 202
- [ ] Set Next.js body size limit to 25MB via route config
- [ ] Return 400 `UNSUPPORTED_FILE_TYPE` and `FILE_TOO_LARGE` cleanly
- [ ] Commit: `feat(api): upload validation and job creation`

### 4. SSE progress streaming

_Satisfies: [MVP11] (in conjunction with the pipeline)_

- [ ] Implement `lib/extract/sse.ts` with a thin event-emitter wrapper that produces a `ReadableStream` for App Router routes
- [ ] Define event types: `stage`, `region_ready`, `done`, `error` (typed shapes documented in `docs/USER_FLOW.md`)
- [ ] Implement `app/api/extract/[jobId]/stream/route.ts` returning `text/event-stream`
- [ ] Pipeline orchestrator (`lib/extract/run.ts`) emits events as each stage transitions
- [ ] Wire `error` events to map error codes → user-friendly messages
- [ ] Commit: `feat(api): sse progress events`

### 5. Letterhead extraction

_Satisfies: [MVP5]_

- [ ] Implement `lib/detect/letterhead.ts` with a default-crop function (top 18% of page 1)
- [ ] Implement the optional smart-boundary scan (top 35% binarize, row-scan for first ≥80%-white row after an ink band)
- [ ] Return a normalized bbox `{x, y, w, h}` plus a `detector: 'heuristic'` tag and a coarse confidence score
- [ ] Wire into the orchestrator after rasterization completes
- [ ] Emit a `region_ready` SSE event when done
- [ ] Commit: `feat(detect): letterhead extraction`

### 6. Footer extraction

_Satisfies: [MVP6]_

- [ ] Implement `lib/detect/footer.ts` with a default-crop function (bottom 12% of last page)
- [ ] Implement the optional smart-boundary scan (row-scan from the bottom up)
- [ ] Return a normalized bbox plus detector tag and a note "same region appears on N total pages" when applicable
- [ ] Wire into the orchestrator
- [ ] Emit `region_ready` SSE event
- [ ] Commit: `feat(detect): footer extraction`

### 7. Signature heuristic

_Satisfies: [MVP7], [MVP8]_

- [ ] Install `sharp`
- [ ] Implement `lib/detect/signature.ts` exporting `detectSignature(pages, opts)`:
  - [ ] Crop the bottom 30% of the last page (color + greyscale)
  - [ ] `sharp().greyscale().threshold(180)` to binarize
  - [ ] Connected-components flood-fill in TypeScript (~200 LOC)
  - [ ] Filter components by aspect ratio (2:1–6:1), area, and stroke-width variance
  - [ ] Pick the largest qualifying component as the signature bbox
  - [ ] Compute confidence (size, isolation, stroke variance)
  - [ ] Return `{ bbox, confidence, detector: 'heuristic' }` or `null` with reason "no candidate region met confidence threshold"
- [ ] Wire into the orchestrator
- [ ] Emit `region_ready` SSE event (or a `null` payload when not detected)
- [ ] Commit: `feat(detect): signature heuristic`

### 8. Region cropping and download endpoint

_Satisfies: [MVP10]_

- [ ] Implement `lib/extract/crop.ts` that takes a normalized bbox + the rasterized color page and writes a PNG to the temp dir
- [ ] Implement `app/api/extract/[jobId]/region/[name]/route.ts` (GET): serve the cached PNG from the temp dir with `Content-Type: image/png`
- [ ] Support `?format=jpeg&quality=N` query params (re-encode from the original color buffer on the fly)
- [ ] Return `404 NOT_FOUND` if the jobId expired; `409 REGION_NOT_DETECTED` if the region had `null` detection
- [ ] Commit: `feat(api): region download endpoint`

### 9. Frontend — upload, preview, results

_Satisfies: [MVP1], [MVP3], [MVP9], [MVP10]_

- [ ] Install `react-dropzone` and `react-pdf`
- [ ] Implement the home page with a dropzone (max 1 file in MVP — batch comes later)
- [ ] Wire dropzone → `POST /api/extract` → store `jobId` in component state
- [ ] Render `react-pdf` preview of the uploaded PDF
- [ ] Open SSE connection to `/api/extract/:jobId/stream` and update progress UI on each event
- [ ] Render three region cards (Letterhead, Footer, Signature) with image previews from `/api/extract/:jobId/region/:name`
- [ ] Render explicit "not detected" state for any region that returns `null`
- [ ] Wire per-region Download buttons (browser-initiated GET)
- [ ] Build a typed `ApiError` shape and an error-to-message mapping component
- [ ] Commit: `feat(ui): upload, preview, and results`

### 10. Graceful error handling end-to-end

_Satisfies: [MVP11]_

- [ ] Verify all error codes from `lib/extract/errors.ts` map to user-friendly messages in the UI
- [ ] Add a global error boundary on the home page
- [ ] Ensure unhandled exceptions in the pipeline emit `error` SSE events rather than killing the process
- [ ] Add a 60-second per-job timeout in the orchestrator; on timeout emit `TIMEOUT` and clean up
- [ ] Add the `503 SERVICE_BUSY` response when queue depth exceeds the cap
- [ ] Commit: `feat: graceful error handling`

### 11. First sample document

_Satisfies: [MVP13]_

- [ ] Author or source a CC0/public-domain single-page letter PDF with clear letterhead, footer, and signature
- [ ] Place at `samples/clean-letter.pdf`
- [ ] Verify manually that all three regions extract correctly with default settings
- [ ] Add a `samples/README.md` describing each sample's purpose
- [ ] Commit: `docs: add clean-letter sample`

### 12. Dockerized setup

_Satisfies: [MVP12]_

- [ ] Author `Dockerfile` based on `node:20-slim`:
  - [ ] Install `libreoffice-core`, `tesseract-ocr`, `tesseract-ocr-eng`, `libfontconfig1`, `libpixman-1-0`, `libcairo2`
  - [ ] Copy `package.json` and `package-lock.json` first, run `npm ci`
  - [ ] Copy source, run `npm run build`
  - [ ] Use a non-root user for the runtime
  - [ ] `HEALTHCHECK` calling `/api/health`
- [ ] Author `docker-compose.yml` with one service, port mapping 3000:3000, env var pass-through, healthcheck wired up
- [ ] Verify locally: `docker compose up` → open http://localhost:3000 → upload `samples/clean-letter.pdf` → see all three regions
- [ ] Commit: `feat: dockerized setup`

---

## Phase 2: Polish

### 13. Vision-model verification fallback

_Satisfies: [FS1], [FS2], [FS3]_

- [ ] Install `@anthropic-ai/sdk`
- [ ] Implement `lib/vision/claude.ts` with `verifySignature(candidateImage, opts)` that sends a cropped region to Claude Sonnet vision and asks for a refined normalized bbox
- [ ] Use the tool-use API or strict JSON-extraction utility to avoid free-form response parsing
- [ ] Implement `lib/vision/budget.ts` — per-request cost tracker; reject calls past `VISION_BUDGET_USD_PER_REQUEST`
- [ ] In `lib/detect/signature.ts`, when confidence < 0.6, call the vision verifier; merge the returned bbox; tag detector as `'vision'`
- [ ] If `ANTHROPIC_API_KEY` is missing, silently disable the fallback and surface a UI hint
- [ ] In the UI, render a small badge per region indicating `heuristic` vs `vision` detection
- [ ] Commit: `feat(detect): vision fallback for signatures`

### 14. DOCX support via LibreOffice

_Satisfies: [FS4]_

- [ ] Install `libreoffice-convert` (or implement a thin shell wrapper around `soffice`)
- [ ] Implement `lib/convert/libreoffice.ts` with `docxToPdf(buffer, tempDir)` that shells out to `soffice --convert-to pdf --norestore --nolockcheck --nodefault --nofirststartwizard -env:UserInstallation=file:///<unique-dir>`
- [ ] Capture stderr; on non-zero exit throw `CONVERSION_FAILED` with stderr in server logs only
- [ ] In `lib/queue/index.ts` wrap LibreOffice calls with `p-queue` at concurrency `HEAVY_CONCURRENCY`
- [ ] In `lib/extract/run.ts`, branch by file type: PDF → straight to rasterize; DOCX/DOC/RTF/ODT → convert then rasterize
- [ ] Add a `samples/letter.docx` fixture
- [ ] Commit: `feat: docx support via libreoffice`

### 15. Image input support

_Satisfies: [FS5]_

- [ ] In `lib/extract/run.ts`, branch image inputs (PNG, JPEG, WEBP, TIFF) to skip rasterization
- [ ] Wrap the image bytes in a "single-page document" shape so the detection functions don't need to know it's not from a PDF
- [ ] Apply max-dimension cap (12000×12000) at validation time
- [ ] Verify all three region detectors run cleanly on a single image
- [ ] Commit: `feat: png/jpeg/webp/tiff inputs`

### 16. OCR fallback for scanned PDFs

_Satisfies: [FS7]_

- [ ] Install `node-tesseract-ocr`
- [ ] Implement `lib/ocr/tesseract.ts` with `ocrPage(imageBuffer)` returning text + a confidence score
- [ ] In the orchestrator, detect "scanned page" by checking that `pdfjs.getTextContent()` returns near-empty text but the rasterized image has substantial ink
- [ ] For scanned pages, route through Tesseract before the boundary scanners run, so they can use the OCR text mask
- [ ] Wrap Tesseract calls with `p-queue` at concurrency `HEAVY_CONCURRENCY`
- [ ] Add `samples/scanned-letter.pdf` fixture
- [ ] Commit: `feat: ocr fallback for scanned pdfs`

### 17. Adjustable crop UI

_Satisfies: [FS8], [FS9]_

- [ ] Install `react-easy-crop`
- [ ] Wrap each region card with `react-easy-crop` pre-filled with the auto-detected bbox
- [ ] Add an "Adjust" toggle that switches the card to crop-edit mode
- [ ] Implement `app/api/extract/[jobId]/recrop/[name]/route.ts` (POST) accepting `{ bbox: { x, y, w, h } }` and writing a new PNG to the temp dir
- [ ] On adjust+save, re-fetch the region URL (cache-busted) so the preview updates
- [ ] Commit: `feat(ui): adjustable crop per region`

### 18. Batch upload and ZIP download

_Satisfies: [FS10], [FS11], [FS12], [FS13]_

- [ ] Install `archiver`
- [ ] Update dropzone to accept up to `MAX_BATCH_FILES` files
- [ ] Implement `app/api/extract/batch/route.ts` (POST): creates N JobRecords + one BatchRecord, returns `{ batchId, jobs[] }`
- [ ] Frontend: replace single-doc preview with a table view; one row per file with status, regions, error
- [ ] Each row opens its own SSE subscription (fan-out)
- [ ] Implement `app/api/extract/[jobId]/zip/route.ts` (GET) — single-doc ZIP of detected regions
- [ ] Implement `app/api/extract/batch/[batchId]/zip/route.ts` (GET) — batch ZIP with `{filename}/{region}.png` layout, X-Failed-Jobs header
- [ ] Failed docs do not fail the batch; render their error in the table
- [ ] Commit: `feat: batch upload and zip download`

### 19. JPEG output and quality parameter

_Satisfies: [FS14]_

- [ ] In `app/api/extract/[jobId]/region/[name]/route.ts`, parse `?format=jpeg&quality=N`
- [ ] When JPEG is requested, re-encode from the original color buffer (cached in the temp dir) rather than transcoding the PNG
- [ ] Clamp quality to [1, 100]; default to 85
- [ ] Commit: `feat(api): jpeg output with quality control`

### 20. Healthcheck endpoint and structured logging

_Satisfies: [FS18], [FS19]_

- [ ] Install `pino` and `pino-pretty` (dev-only for human-readable local logs)
- [ ] Implement `app/api/health/route.ts` returning `{ status, libreoffice, tesseract, freeDiskMB, queueDepth, uptimeSeconds }`
- [ ] On startup, probe LibreOffice and Tesseract availability and cache the result
- [ ] Hook `pino` into the orchestrator; emit one log line per stage transition with `requestId`, `stage`, `durationMs`, `detector`, `confidence`
- [ ] Wire Docker `HEALTHCHECK` to call `/api/health`
- [ ] Verify logs never contain file bytes
- [ ] Commit: `feat: healthcheck and structured logging`

---

## Phase 3: Final

### 21. Test suite

_Satisfies: [FS15], [FS16], [FS17]_

- [ ] Install `vitest`, `@vitest/coverage-v8`, `supertest`, `@playwright/test`
- [ ] Author 9 unit tests per the catalog in `docs/TESTING_STRATEGY.md` (signature heuristic × 6, cropping math, file-type validation × 2)
- [ ] Author 5 integration tests per the catalog (happy path, unsupported file, encrypted PDF, oversize file, region download)
- [ ] Author 1 Playwright E2E test: upload sample, see regions, download signature
- [ ] Add `npm run test`, `npm run test:e2e`, `npm run test:coverage` scripts
- [ ] Verify the full suite runs in under 30 seconds (excluding E2E)
- [ ] Commit: `test: unit, integration, and e2e coverage`

### 22. Additional sample documents

_Satisfies: prerequisite for testing varied flows_

- [ ] Author or source `samples/multi-page-report.pdf` (exercises footer-on-every-page logic)
- [ ] Author or source `samples/scanned-letter.pdf` (exercises OCR fallback)
- [ ] Author or source `samples/letter.docx` (exercises LibreOffice pipeline)
- [ ] Update `samples/README.md` with the per-file purpose and what each demonstrates
- [ ] Commit: `docs: additional sample documents`

### 23. README

_Satisfies: brief's documentation deliverable_

- [ ] Author `README.md` with these sections (per `presearch.md` §14):
  - [ ] **Setup and run** — one command (`docker compose up`), npm-script alternative, optional `ANTHROPIC_API_KEY`
  - [ ] **Architectural choices and trade-offs** — distilled from `docs/MEMO.md`, one paragraph per major decision
  - [ ] **Known limitations and what we'd improve given more time** — populated from the time-cap cut list plus the forward-looking improvements list
  - [ ] **Supported file types** — three tiers from `presearch.md` §6
  - [ ] **Sample documents** — pointer to `samples/` with one-line per-fixture description
  - [ ] **Tests** — how to run unit, integration, E2E
  - [ ] **Documented assumptions** — the 10 explicit assumptions from `presearch.md` §15
- [ ] Commit: `docs: README`

### 24. CI pipeline

_Satisfies: code-quality signal (not strictly required by the brief)_

- [ ] Author `.github/workflows/ci.yml` per `docs/TESTING_STRATEGY.md` "CI Integration"
- [ ] Lint, typecheck, test jobs in one runner
- [ ] Separate `docker-build` job verifying the image builds and `/api/health` returns 200
- [ ] Commit: `ci: lint, typecheck, test, docker build`

### 25. Final review and submission pass

- [ ] Run `npm run lint`, `npm run typecheck`, `npm run test`, `npm run test:e2e` — all green
- [ ] Run `docker compose up` from a clean clone — verify end-to-end
- [ ] Review every commit message against Conventional Commits style
- [ ] Verify no `.env.local` or secret values were ever committed (`git log -p | grep ANTHROPIC_API_KEY` should only find the variable name)
- [ ] Verify the README matches the actual behavior (no stale claims)
- [ ] Verify all sample documents are committed and load correctly
- [ ] Verify the healthcheck reports `ok` in the running container
- [ ] Submit
