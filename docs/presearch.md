# Presearch — Document Extractor

**Date:** 2026-05-20
**Purpose:** Capture the library research, region-detection details, and cross-cutting decisions (security, concurrency, UX, testing) that inform the architecture for the Full Stack Engineer technical assessment. This document is the input to `architecture.md` (next step).

## Confirmed constraints (from the user)

These were settled before research and frame every recommendation below.

- **App structure:** Single Next.js (App Router) TypeScript app. Frontend + API routes in one repo.
- **LLM/Vision API:** Allowed as a fallback only — our own logic must be the primary mechanism (matches brief's "should not be the only mechanism").
- **Deployment:** Docker, single command (`docker compose up`). Reviewers should not need Node/Python installed.
- **Persistence:** Stateless. Temp files only. No database, no object storage.

## Research questions

1. What's the best PDF-to-image library for a Node/TS backend in Docker?
2. What's the best primary approach for signature detection, given LLM-as-fallback only?
3. What's the best way to handle `.docx` (a nice-to-have) without ballooning the toolchain?
4. What's the best OCR option for scanned PDFs (also a nice-to-have)?
5. What cross-cutting concerns (security, concurrency, UX, testing) do we need decisions on before architecture?

---

## 1. PDF rasterization

We need a high-DPI PNG buffer per page so we can crop regions with `sharp`.

| Library | Native deps | Docker friendliness | TS | License | Notes |
|---|---|---|---|---|---|
| `mupdf` (Artifex WASM) | None (WASM) | Trivial on Alpine + Debian | First-class | **AGPL or commercial** | Fastest, reference render quality |
| `pdfjs-dist` + `@napi-rs/canvas` | napi prebuild | Easy on `node:20-slim`, broken on Alpine/musl | Excellent | Apache-2.0 / MIT | Mozilla-maintained, ~3M weekly DLs |
| `pdf2pic` | GraphicsMagick + Ghostscript | Adds ~50MB, GS is AGPL | Thin | Mixed | Slowest, fragile shell args |
| `node-poppler` | `poppler-utils` | Fine on Alpine | Good | GPL binaries (CLI invocation usually OK) | Solid but extra system dep |
| `unpdf` | wraps PDF.js | Same as pdfjs-dist | Good | MIT | Nicer ergonomics, same engine |

**Recommendation: `pdfjs-dist` + `@napi-rs/canvas` on a Debian-slim Docker base.**

Reasoning:
- `mupdf` is technically the best engine, but the AGPL license is a footgun for a technical assessment we want to make permissively shareable.
- `pdfjs-dist` is Apache-2.0, has the best community support, and the napi-rs canvas binding is a one-line install on `node:20-slim`.
- We avoid Alpine specifically because `@napi-rs/canvas` musl prebuilds have been historically unreliable. Debian-slim costs ~30MB more but eliminates a class of "works on my machine" bugs.

**Fallback option:** if performance becomes an issue on multi-hundred-page PDFs, swap to `mupdf` behind the same `PageRasterizer` interface.

### Rasterization parameters

These are high-leverage choices, called out explicitly:

- **DPI: 200.** 150 DPI is fine for letterhead/footer (large regions, forgiving) but signature detection at 150 DPI loses thin-stroke fidelity, hurting heuristic accuracy. 300 DPI quadruples memory per page vs 150 with diminishing returns. 200 is the sweet spot — empirically ~1.8MB per A4 page in RAM, signatures still readable.
- **Output color space: greyscale during detection, original color in final crop.** We threshold and find contours on greyscale (faster, smaller). The downloadable crop is from the original color render so the user gets a faithful image.
- **Per-request page cap: 50.** Hard limit. Beyond this we either reject with a clear error or fall back to processing only first/last pages depending on which regions are requested. Bounds the worst-case memory.

---

## 2. Signature detection

This is the only genuinely ambiguous region. Letterhead = top of page 1; footer = bottom of every page (or last only — see §5). Signature is open-ended.

| Approach | Accuracy | Deps | Fit for 4–6hr build |
|---|---|---|---|
| OpenCV native bindings (`@u4/opencv4nodejs`) | 75–85% | ~400MB Docker bloat | Too heavy |
| `opencv.js` (WASM) | 75–85% | None | Doable but ~8MB WASM and more API surface |
| `sharp` + connected-components heuristic | 70–80% | `sharp` only (already in stack) | **Best fit** |
| OCR-gap (Tesseract finds "no text but ink" zones) | 80% when it works | tesseract.js | Risky as primary; useful as secondary signal |
| Pretrained ONNX (YOLOv8-signature, etc.) | 90%+ | onnxruntime-node, unmaintained weights | Eats the whole time budget |
| Claude vision fallback | ~95% | Anthropic SDK | Great as fallback, ~$0.003/page |

**Recommendation: `sharp` + connected-components heuristic as primary, Claude vision as fallback.**

The heuristic is roughly:
1. Crop the bottom 30% of the last page.
2. `sharp().greyscale().threshold(180)` to binarize.
3. Find connected components of dark pixels (simple flood-fill in TS, ~200 LOC).
4. Filter components by aspect ratio (2:1–6:1), area, and stroke-width variance — printed text has uniform stroke width, signatures don't.
5. The largest qualifying component is the signature bbox. Compute a confidence score (size, isolation, stroke variance).
6. **If confidence < 0.6**, send the candidate region to Claude vision and ask it to verify and refine the bbox in normalized coords.

This satisfies the brief's "should not be the only mechanism" requirement: our heuristic is primary and always runs; the LLM only kicks in when we're unsure. We log which path produced each result so we can show it in the UI ("detected by heuristic" vs "verified by vision model").

**Skipped on purpose:** OpenCV native (too heavy for the value-add over sharp), ONNX models (sourcing and validating a maintained signature-detection model would eat the entire budget).

### Cost ceiling for vision fallback

- Per-page cost ~$0.003 with Claude Sonnet vision on a cropped region.
- **Per-request budget: $0.05** (~16 fallback calls). At our 50-page cap this means we won't call vision on every page even if every page fails the heuristic. If the budget is exhausted we return what we have plus an "unverified" flag on remaining regions.
- API key is read from `ANTHROPIC_API_KEY` env. If missing, the fallback is silently disabled and we surface a UI hint ("low-confidence detection — provide an API key for verification").

---

## 3. DOCX handling

| Option | Docker cost | Fidelity | Notes |
|---|---|---|---|
| `mammoth` → HTML → PDF (Puppeteer) | +~300MB (Chromium) | Loses Word layout | Two new toolchains |
| `docx-preview` | Needs headless browser | Fragile on complex docs | Browser-first lib |
| Headless LibreOffice `soffice --convert-to pdf` | +~400MB (libreoffice-core) | **Highest — Word-accurate pagination** | One new binary |
| Pure-JS DOCX→image | None mature in 2026 | Poor | Not viable |

**Recommendation: headless LibreOffice → PDF → reuse PDF pipeline.**

Reasoning:
- We already have a PDF→image pipeline. Converting `.docx` → PDF first means **zero new image-processing code**.
- One new system binary (`libreoffice-core`) unlocks `.doc`, `.rtf`, `.odt`, `.pptx`, `.xlsx` for free — useful future-proofing.
- `mammoth` is tempting because it's pure-JS, but losing Word's pagination means our "footer of every page" extraction would be wrong, since HTML has no concept of pages until we re-paginate with Chromium anyway.

**Trade-off acknowledged:** LibreOffice adds ~400MB to the Docker image and is single-threaded per process. See §7 for how the concurrency model handles this.

---

## 4. OCR (scanned PDFs)

| Option | Docker cost | Accuracy | Speed |
|---|---|---|---|
| `tesseract.js` (WASM) | None | Same engine | 2–5x slower than native, heavy RAM |
| `node-tesseract-ocr` (system Tesseract 5.x) | +1 apt package | Best open-source | Native C++ speed |
| Google Document AI / AWS Textract | SDK only | Best on noisy scans | Network-bound, ~$1.50/1k pages |

**Recommendation: `node-tesseract-ocr` wrapping system Tesseract 5.x.**

Reasoning:
- We already rasterize PDFs to PNG, so Tesseract's lack of native PDF input is moot — we feed it our existing page images.
- Native Tesseract is markedly faster than WASM and adds only one apt package (`tesseract-ocr tesseract-ocr-eng`).
- We can detect "scanned PDF" by checking if `pdfjs` extracts any text content from a page. If text content is near-empty but the rasterized image has lots of ink, run OCR.

**Cloud OCR** is the right escape hatch for noisy/handwritten scans but should not be the default for cost and privacy reasons.

---

## 5. Region detection details

The brief calls letterhead and footer "trivial." They're easier than signature but not zero-decision.

### Letterhead

- **Default crop:** top 18% of page 1.
- **Smarter detection (if time allows):** binarize the top 35% of page 1, scan rows top-to-bottom, find the first row with ≥80% white pixels after a band of ink — that's the boundary between letterhead and body. Falls back to fixed 18% if no clear boundary.
- **Image input:** treat the whole image as page 1 and apply the same logic.

### Footer

Open question the brief leaves to us: every page, or just last page?

- **Default:** last page only. Reasoning: in most documents the footer is the same on every page (page numbers, address line), so returning N near-identical crops is poor UX. We return one crop with a note in the metadata: "footer detected on last page; same region appears on N total pages."
- **Smarter detection:** crop bottom 12%, then row-scan from the bottom up to find the boundary. Same fallback as letterhead.
- **UI:** if the user wants per-page footers, the adjustable-crop UI lets them request it. We don't bake it into the default response.

### Signature

Already covered in §2. One addition: if no signature is detected even after vision fallback, the response includes `signature: null` with `reason: "no candidate region met confidence threshold"` — the brief explicitly requires that the UI communicate "region not present."

### Output format

- **Default: PNG.** Lossless, preserves crisp text/ink edges in letterhead and signature, supports transparency for any future masking work.
- **Optional `?format=jpeg&quality=85` query param** for users who want smaller downloads. JPEG quality 85 is the universally safe default.
- **All crops returned at native rasterization DPI** (no re-scaling), so what the user downloads matches what they previewed.

---

## 6. Input handling

The brief lists "image inputs" as a nice-to-have. We mostly get it for free, but each input type is a distinct code path.

### Supported file types (three tiers)

**Tier 1 — first-class (tested, advertised in UI):**

| Type | Validation | Processing path |
|---|---|---|
| PDF | Magic bytes (`%PDF-`), page count ≤ 50, not encrypted, parseable | Rasterize → detect → crop |
| DOCX | OOXML magic bytes | LibreOffice → PDF → above pipeline |
| PNG | Magic bytes, max dimensions | Skip rasterization → treat as single page → detect → crop |
| JPEG | Magic bytes, max dimensions | Skip rasterization → treat as single page → detect → crop |

These four cover the brief's required scope + both relevant bonus items ("docx" and "image inputs").

**Tier 2 — accepted via existing toolchain, mentioned in README, not heavily tested:**

| Type | Why it works |
|---|---|
| DOC (legacy Word) | LibreOffice handles it, same path as DOCX |
| RTF | LibreOffice handles it |
| ODT (OpenDocument Text) | LibreOffice handles it |
| WEBP, TIFF | sharp handles them natively (TIFF is common for scans) |

We accept these because they cost nothing — same code path, same toolchain. The README will list them as "also accepted, not extensively tested."

**Tier 3 — explicitly rejected with a clear error message:**

| Type | Why rejected |
|---|---|
| PPTX, PPT | Slide semantics don't map to "letterhead/footer/signature" cleanly |
| XLSX, XLS, CSV | Spreadsheet/tabular semantics don't map to image regions |
| HTML, EPUB | Would require Chromium toolchain we deliberately avoided |
| Apple `.pages` | LibreOffice can't open it natively |
| Everything else | Default reject |

Rejection returns `UNSUPPORTED_FILE_TYPE` with a message listing the supported types.

### Validation rules

- **Magic bytes only, never extension.** A `.pdf` extension on a `.exe` is a known attack vector; we use `file-type` (npm) to sniff the first bytes.
- **Size limit: 25MB upload max.** Next.js App Router default body limit needs to be raised explicitly in `route.ts` config.
- **Image dimension cap: 12000 × 12000 px.** Bounds memory; ~430MB raw RGBA at 4-byte-per-pixel worst case, which sharp streams rather than materializing fully.

### Direct image input semantics

"Letterhead of an image" = top portion of that image. "Footer of an image" = bottom portion. "Signature of an image" runs the signature heuristic on the whole image. The semantics map cleanly — only the rasterization step is skipped.

### Batch upload

A bonus the brief explicitly calls out: "batch upload and ZIP download of all extracted regions." We support multi-document upload:

- The dropzone accepts N files at once (up to 10 per batch).
- Each file becomes its own job ID; the UI shows a table with per-doc status.
- Per-doc results render as they complete (parallel processing, bounded by the concurrency queue from §7).
- A "Download all as ZIP" button packages every detected region from every doc into one archive with a clear directory structure: `batch-{timestamp}/{original-filename}/{region}.png`.
- Per-doc errors don't fail the batch — failed docs appear in the table with their error, successful docs are still downloadable.

---

## 7. Concurrency model

LibreOffice is single-threaded per process. Tesseract and pdfjs are not, but they're CPU-bound. "Stateless" doesn't mean "concurrency-safe under load."

**Recommendation: in-process queue with concurrency limit of 2 for heavy steps (LibreOffice, Tesseract).**

- Use `p-queue` (or hand-rolled, it's ~30 LOC) to serialize DOCX→PDF conversions and OCR runs to 2 concurrent jobs.
- Sharp/pdfjs rasterization runs unbounded (they handle their own threading well).
- Per-request timeout: 60s hard cap. Reject with 503 if queue depth > 10.
- **Why 2 and not 1:** allows one in-flight job to make progress while another is starting, without thrashing on a single-core dev machine.

For production-scale this would graduate to a separate worker container behind Redis/BullMQ, but that's overkill for an assessment app. The interface around the queue is what matters — when we extract to a worker process later, no API code changes.

---

## 8. Security and hardening

PDF and DOCX are both well-known attack surfaces. The Docker container needs to be defensive:

- **Validate file type by magic bytes** (`file-type` npm), not extension.
- **Reject encrypted PDFs early** — `pdfjs` will tell us on parse. Surface a clear "we don't support password-protected PDFs" error (`ENCRYPTED_PDF`).
- **Handle malformed/corrupt PDFs gracefully** — wrap `pdfjs.getDocument()` in try/catch; truncated, bad-checksum, or partially-written PDFs surface as `MALFORMED_PDF` with the underlying parser error in logs (not exposed to user). Same pattern for LibreOffice conversion failures (`CONVERSION_FAILED`).
- **Disable PDF JavaScript** at the pdfjs config level (`isEvalSupported: false`).
- **Bound work:** 25MB file size, 50 pages, 60s timeout. Each is a defense against decompression/billion-laughs/zip-bomb-style attacks.
- **Run LibreOffice as a non-root user with `--norestore --nolockcheck --nodefault --nofirststartwizard`** in a sandboxed temp directory it can't escape.
- **No network egress from the document-processing path** except the explicit Claude vision API call. The Docker container itself can have a restricted egress allowlist in `docker-compose.yml`.
- **Temp file lifecycle:** generated under `os.tmpdir()/extractor-{requestId}/`, deleted in a `finally` block. A background sweeper runs every 5 minutes to clean directories older than 10 minutes (covers crashed requests).
- **No persisted user data.** No analytics, no logging of file contents (only filenames + sizes + processing metadata).

---

## 9. Frontend stack

The brief evaluates UX and "sensible defaults," so this isn't optional polish.

- **Styling: Tailwind CSS v4 + shadcn/ui.** Standard, fast to assemble, reviewers expect it. Components needed: Button, Card, Dialog, Progress, Alert, Tabs.
- **File upload: `react-dropzone`.** Drag-drop, click-to-select, file type filtering, all from one well-tested component.
- **PDF preview: `react-pdf`** (wraps pdfjs in a React component). Renders the uploaded PDF as scrollable pages with reasonable defaults.
- **Adjustable crop UI: `react-easy-crop`** for each of the three regions. Shows the auto-detected box pre-filled; user can drag/resize before downloading. The crop bounds are normalized 0–1 coords so they map cleanly to the rasterized image regardless of DPI.
- **State: React `useState` + `useReducer`.** No Zustand/Redux — the app has one extraction job in flight at a time on the client.
- **Server interaction: native `fetch` + Server-Sent Events** for progress updates (see §10).
- **Error UI:** every error from the backend has a typed error code (`UNSUPPORTED_FILE`, `ENCRYPTED_PDF`, `NO_SIGNATURE_FOUND`, etc.) and a user-friendly message. The brief weighs this heavily.

---

## 10. API contract (preliminary)

Full spec lives in `architecture.md`; the lean here is:

- **`POST /api/extract`** (multipart): accepts the upload, immediately returns `{ jobId }`.
- **`GET /api/extract/:jobId/stream`** (SSE): streams events `{ stage, progress, partial? }` as each stage completes. Stages: `validating`, `rasterizing`, `detecting_letterhead`, `detecting_footer`, `detecting_signature`, `done`.
- **`GET /api/extract/:jobId/region/:name`** (PNG/JPEG): returns the cropped image for download. `name` ∈ `letterhead | footer | signature`.
- **`GET /api/extract/:jobId/zip`** (ZIP): returns all detected regions for a single doc as one archive.
- **`POST /api/extract/batch`** (multipart, N files): returns `{ batchId, jobIds[] }`. Each job streams independently via its own SSE endpoint; the frontend fans out N subscriptions.
- **`GET /api/extract/batch/:batchId/zip`** (ZIP): returns all regions from all completed jobs in the batch, organized as `{original-filename}/{region}.png`.

Why SSE over polling: progress feels immediate even on slow OCR pages; the brief weighs UX. Why not WebSocket: SSE is one-direction and one less moving part — perfect fit.

Why a job ID instead of returning crops inline from the POST: lets the user start the download of one region while another is still processing, and lets the crop UI request a re-crop with new bounds without re-uploading.

The jobId points to an in-memory job record (per-process map) that expires when the temp dir is cleaned up. No DB — the assessment is single-process.

---

## 11. Testing strategy

The brief lists tests as nice-to-have but not what to test. Proposal:

- **Unit (Vitest):**
  - Heuristic signature detector against ~6 synthetic fixtures (clean signature, no signature, signature at edge, two signatures, noisy background, scanned).
  - Region cropping math (normalized → pixel coords across DPIs).
  - File-type validation (magic bytes for PDF, DOCX, PNG, plus rejection of `.exe-as-pdf`).
- **Integration (Vitest + supertest):**
  - `POST /api/extract` happy path with a real sample PDF, asserting all three regions are returned.
  - Error paths: unsupported file, encrypted PDF, file too large.
- **E2E (Playwright):** one test — upload sample PDF, wait for completion, verify all three preview images render, click download on signature.

Target: ~15 tests total, runnable in <30 seconds. Good faith demonstration, not exhaustive coverage.

---

## 12. Observability

- **Healthcheck:** `GET /api/health` returns `{ status, libreoffice: bool, tesseract: bool }`. Docker uses this for its `HEALTHCHECK` directive.
- **Structured logging:** `pino` with one log line per stage transition. Fields: `requestId`, `stage`, `durationMs`, `detector` (heuristic vs vision), `confidence`. Helps debugging and makes it visible during the live walkthrough.
- **No external telemetry** (no Sentry, no analytics) — keeps the app self-contained and avoids surprising reviewers with network calls.

---

## 13. Code quality toolchain

The evaluation criteria lead with "code quality: readability, structure, typing, separation of concerns." Toolchain choices to back that up:

- **TypeScript strict mode** — `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true` in `tsconfig.json`. No `any` allowed; if we need an escape hatch it's `unknown` + a type guard.
- **ESLint** with `@typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-react-hooks`. Standard Next.js config as a base, then tighten.
- **Prettier** with project config committed. Single source of truth for formatting; no debates.
- **`tsc --noEmit` in CI / pre-commit** — catches type errors before they reach review.
- **Separation of concerns** — clear `lib/extract/`, `lib/rasterize/`, `lib/detect/`, `lib/convert/`, `lib/ocr/`, `lib/vision/` modules, each with a single public interface. Route handlers in `app/api/` are thin — orchestration only, no business logic.
- **No barrel files** — explicit imports keep the module graph traceable and tree-shakes cleanly.

## 14. README plan

The brief is explicit about three required README sections. We plan them up front so the writing isn't an afterthought:

1. **Setup and run instructions** — one command (`docker compose up`), plus the npm-script alternative for those who want to poke at the code. Includes the optional `ANTHROPIC_API_KEY` env var for the vision fallback.
2. **Architectural choices and trade-offs** — distilled from `architecture.md`. Why Next.js single-app, why pdfjs over mupdf, why LibreOffice for DOCX, why sharp + heuristic for signature, why SSE for progress, why stateless. One paragraph per decision.
3. **Known limitations and what we'd improve given more time** — populated from §15 (cut list) plus a forward-looking list: separate worker container with Redis/BullMQ, ONNX signature model, per-tenant rate limits, Postgres+S3 if multi-user, observability via OpenTelemetry.

Plus a brief "Supported file types" section listing the three tiers from §6, a "Sample documents" section pointing at `samples/`, and a "Tests" section with the run command.

## 15. Assumptions, time-cap, and cut list

### Documented assumptions (will live in README)

The brief says "Document your assumptions in the README." Consolidated here so we don't lose them:

1. **Letterhead = top 18% of page 1** unless smart-boundary detection finds an obvious whitespace gap.
2. **Footer = bottom 12% of last page only** by default. Multi-page footers exposed via adjustable-crop UI.
3. **Signature = bottom 30% of last page**, largest connected component matching aspect/size/stroke-variance heuristics.
4. **Rasterization DPI = 200** — chosen to balance signature-detection fidelity against memory.
5. **Page cap = 50** per document; **file size cap = 25MB**; **batch cap = 10 files**; **timeout = 60s/job**.
6. **PNG output by default**; JPEG via query param.
7. **English-only OCR** with `tesseract-ocr-eng`. Other languages would need additional `tesseract-ocr-{lang}` packages.
8. **Vision fallback budget = $0.05/request.** Disabled silently if `ANTHROPIC_API_KEY` is absent.
9. **Stateless** — temp files cleaned on response + background sweeper at 10 minutes. No persistence between requests.
10. **Single-tenant** — no auth, no rate limiting beyond the queue. Production would add both.

### Time-cap plan

Brief suggests 4–6 hours; "doing all the nice-to-haves" pushes us closer to 8–10. Plan: timebox at 8 hours, and if we hit hour 7 with anything below incomplete, cut in this order:

1. **First to cut: vision fallback.** Heuristic alone hits the brief's bar. Vision is polish.
2. **Then: batch upload.** Single-doc covers the brief's required flow.
3. **Then: adjustable crop UI.** The auto-detected crops alone satisfy "view + download."
4. **Then: OCR.** Most assessment PDFs won't be scanned.
5. **Then: DOCX.** PDF-only still meets the minimum bar.
6. **Never cut:** tests, Docker, error handling, README, sample docs — these are evaluation-criteria items, not nice-to-haves.

Anything cut goes straight into the README's "what we'd do with more time" section with a one-line plan for how we'd add it back.

## 16. Sample documents and commit hygiene

- **Sample docs to commit** under `samples/`:
  - `clean-letter.pdf` — single-page letter with all three regions clearly present. Sourced from a CC0/public-domain template (or generated from a Word doc we author).
  - `multi-page-report.pdf` — exercises footer-on-every-page logic.
  - `scanned-letter.pdf` — exercises OCR fallback. Either scan a printed test doc or use a known public scanned fixture from a CC dataset.
  - `letter.docx` — exercises the LibreOffice pipeline.
- **Commit history:** the brief calls out "clear commit history" as a deliverable. Plan: small atomic commits in this order — (1) scaffold, (2) PDF rasterization, (3) letterhead+footer crop, (4) signature heuristic, (5) vision fallback, (6) DOCX support, (7) OCR support, (8) frontend, (9) adjustable crop UI, (10) ZIP download, (11) Dockerfile + compose, (12) tests, (13) README. Each commit message follows Conventional Commits style.

---

## Final stack summary

After research, the Docker image needs:

- **Base:** `node:20-slim` (Debian)
- **System packages:** `libreoffice-core`, `tesseract-ocr`, `tesseract-ocr-eng`, plus the apt deps `@napi-rs/canvas` needs (~450MB total — acceptable for a self-contained reviewer experience)
- **Node deps:**
  - Backend: `next`, `react`, `sharp`, `pdfjs-dist`, `@napi-rs/canvas`, `node-tesseract-ocr`, `libreoffice-convert` (or shell out), `@anthropic-ai/sdk`, `file-type`, `p-queue`, `pino`, `archiver`
  - Frontend: `tailwindcss`, `shadcn/ui` deps, `react-dropzone`, `react-pdf`, `react-easy-crop`
  - Dev: `vitest`, `@playwright/test`, `supertest`
- **No new toolchains:** no Python, no OpenCV native, no Chromium, no Ghostscript

This satisfies every nice-to-have in the brief:
- Scanned PDF OCR fallback → Tesseract pipeline
- `.docx` and image inputs → LibreOffice + direct image handling via sharp
- Adjustable crop regions in UI → `react-easy-crop` per region, normalized coords map to backend
- Batch upload + ZIP download → `archiver`
- Tests → Vitest + Playwright, ~15 tests
- Dockerised setup → `Dockerfile` + `docker-compose.yml`, healthcheck wired up

## Open questions for the architecture doc

Most of the original open questions have been answered above. Remaining for architecture:

1. **Exact directory layout** of the Next.js app — where do `lib/extract/`, `lib/rasterize/`, `lib/detect/` live, and how do they expose their interfaces?
2. **Module boundaries** — is the extraction pipeline pure functions composed in a `route.ts`, or wrapped in a class? Affects testability and the future "extract to worker" path.
3. **Error code taxonomy** — finalize the list of typed error codes returned by the API so the frontend has a complete mapping.
4. **Vision prompt design** — the exact prompt we send Claude when refining a signature bbox, with examples and the expected JSON response shape.

These get decided in `architecture.md` next.

## Sources

- [mupdf - npm](https://www.npmjs.com/package/mupdf)
- [MuPDF License](https://mupdf.readthedocs.io/en/1.27.0/license.html)
- [pdfjs-dist - npm](https://www.npmjs.com/package/pdfjs-dist)
- [@napi-rs/canvas Alpine issue](https://github.com/mozilla/pdf.js/issues/19145)
- [unpdf vs pdfjs-dist 2026](https://www.pkgpulse.com/blog/unpdf-vs-pdf-parse-vs-pdfjs-dist-pdf-parsing-extraction-nodejs-2026)
- [LibreOffice in Docker for document conversion](https://oneuptime.com/blog/post/2026-02-08-how-to-run-libreoffice-in-docker-for-document-conversion/view)
- [mammoth vs libreoffice-convert comparison](https://npm-compare.com/docxtemplater,libreoffice-convert,mammoth)
- [Tesseract OCR in 2026](https://www.koncile.ai/en/ressources/is-tesseract-still-the-best-open-source-ocr)
- [Document AI vs Tesseract](https://dev.to/acetoolz/ocr-integration-in-web-apps-google-document-ai-vs-tesseract-44od)
