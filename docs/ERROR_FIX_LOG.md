# Error & Fix Log

This is the canonical place to record errors that took non-trivial time to diagnose, so we can recognize them quickly if they reappear. The intent is institutional memory, not a bug tracker — bugs in flight live in `docs/TASK_LIST.md` or a separate issue tracker.

## Template

Each entry follows this shape:

```markdown
### [YYYY-MM-DD] <one-line title>

- **Error:** the exact error message, exit code, or symptom
- **Context:** what we were trying to do (stage, input type, recent change)
- **Root Cause:** what was actually wrong, not just what the error said
- **Fix:** the change that resolved it (paste a diff or a commit ref if helpful)
- **Prevention:** what we changed to prevent recurrence (test, type, lint rule, doc note)
```

Log entries are append-only. If a previous entry's "Fix" turns out to be wrong, write a new entry referencing the old one.

### When to log

Log any of the following:

- Build failures that took more than 5 minutes to diagnose
- Runtime errors that escaped local testing and reproduced
- Docker / Docker Compose failures that required adjusting the image or compose file
- API errors from Anthropic, LibreOffice exit codes, Tesseract failures, pdfjs parse errors
- Database / storage errors _(not applicable — this app is stateless)_
- Deployment errors
- Anything that took more than 5 minutes to diagnose

### When NOT to log

Do **not** log:

- Typos and obvious syntax errors
- ESLint or Prettier warnings — fix them, don't document them
- Expected test failures during TDD
- Errors from intentionally malformed inputs in tests (those belong in test comments if anywhere)

## Log

### [2026-05-20] Pipeline fails with INTERNAL_ERROR/MALFORMED_PDF at runtime under Next, despite all unit tests passing

- **Error:** Smoke-test via `npm run dev` and `npm start` both fail. `POST /api/extract` succeeds (202). The SSE stream emits `event: stage` with `stage: 'rasterizing'`, then immediately `event: error` with `code: 'INTERNAL_ERROR'` (production) or `code: 'MALFORMED_PDF'` (dev mode). Same `samples/clean-letter.pdf` input that all 136 unit/integration tests parse without issue.
- **Context:** Group 9 manual smoke-test. The UI is irrelevant — the failure is at the server-side pipeline boundary. `rasterizePages()` works fine when called directly from Vitest; it explodes when invoked from a Next route handler.
- **Root Cause:** Not yet diagnosed. Strong suspicion: `serverExternalPackages: ['pdfjs-dist']` in `next.config.ts` causes Next to load pdfjs via Node's `require` resolver at runtime, but Vitest loads it via Vite's resolver (which handles the ESM `legacy/build/pdf.mjs` path differently). The lazy `ensureWorkerSrc()` may also be resolving to a different path under Next than under Vitest.
- **Fix:** **Not yet applied.** Group 9 (UI) does not introduce this regression — the pipeline was already broken under `npm run dev`; group 9 just surfaced it because we finally had a way to hit `POST /api/extract` from outside the test runner. Likely fixes to try: (1) check whether the worker file actually exists at the `require.resolve`d path in the production bundle; (2) consider switching from `serverExternalPackages` to `next.config.ts experimental.serverComponentsExternalPackages` (old name) or removing the external entirely; (3) verify Next is actually copying `pdfjs-dist/legacy/build/pdf.worker.mjs` into the build output.
- **Prevention:** **The integration test in `route.test.ts` covers a real PDF through the orchestrator, but it injects bytes via `readUploadBytes` override instead of reading from disk via Next's request flow. That gap is what allowed this regression to land in earlier groups undetected.** Worth adding a true end-to-end test in a later group that spawns `next start` and hits the route via fetch — slow but catches this class of issue.

- **Error:** Turbopack build's static-prerender pass on `/page` failed with `ReferenceError: DOMMatrix is not defined` and `Failed to load external module pdfjs-dist-...`. The page is a `'use client'` component but Next still imports its module graph for the initial HTML render.
- **Context:** Group 9, wiring `<PdfPreview />` (which uses react-pdf, which imports pdfjs-dist) into `<HomePage />`. Vitest tests pass; the dev server runs; only the production build trips this.
- **Root Cause:** react-pdf's import of pdfjs-dist touches `DOMMatrix` (a browser-only API) at module load. Even though `<PdfPreview />` is gated behind `'use client'`, Next 16's static prerender walks the import graph synchronously and evaluates pdfjs-dist in the Node context where `DOMMatrix` doesn't exist.
- **Fix:** Replaced the static `import { PdfPreview }` in `<HomePage />` with `dynamic(() => import('@/components/pdf-preview').then(m => m.PdfPreview), { ssr: false })` from `next/dynamic`. That keeps pdfjs-dist out of the server-side bundle entirely; it loads only in the browser when `<PdfPreview />` is first rendered.
- **Prevention:** Any client component that pulls in a browser-only library at module init (pdfjs-dist, anything using `window`, `DOMMatrix`, `OffscreenCanvas`, etc.) must be loaded via `next/dynamic` with `ssr: false`. Adding to `serverExternalPackages` is *not* sufficient — that controls how the dep is bundled, not whether Next tries to evaluate it during prerender. Watch for this on future client deps in groups 17 (react-easy-crop) and 18 (archiver in the UI download path).

### [2026-05-20] `npm run build` fails on @napi-rs/canvas + pdfjs workerSrc

- **Error:** Turbopack build failure with two distinct symptoms after wiring `defaultStages` into the stream route. First: `non-ecmascript placeable asset / asset is not placeable in ESM chunks` against `@napi-rs/canvas/js-binding.js`. After fix, second: `Invalid 'workerSrc' type` during Next's "Collecting page data" phase.
- **Context:** Group 5, wiring `src/lib/extract/stages.ts → defaultStages.rasterize` into the App Router route. Vitest tests passed before the build was run. `npm run dev` works (no Turbopack build).
- **Root Cause:** Two layered issues. (1) `@napi-rs/canvas` ships a `.node` native binary that Turbopack can't bundle into the server output. (2) `src/lib/rasterize/pdfjs.ts` set `pdfjs.GlobalWorkerOptions.workerSrc` at module-load time, which Next evaluates during the "collect page data" phase before any request reaches the route — `require.resolve` was somehow returning an unexpected value in that context.
- **Fix:**
  1. Added `serverExternalPackages: ['@napi-rs/canvas', 'pdfjs-dist']` to `next.config.ts`. Both are Node-native dependencies; they should load as CommonJS at runtime, never be bundled.
  2. Lazy-initialized `workerSrc` in `src/lib/rasterize/pdfjs.ts` via an `ensureWorkerSrc()` call at the top of `rasterizePages`. The module no longer touches `GlobalWorkerOptions` until the first real call.
- **Prevention:** Anything that needs to read native binaries or do filesystem resolution at module-load time should be deferred to first call. The `ensureWorkerSrc()` pattern is the template — copy it when groups 14 (LibreOffice) and 16 (Tesseract) wire in their respective binaries.

### [2026-05-20] Synthetic PDF fixtures render without text under pdfjs Node mode

- **Error:** `samples/clean-letter.pdf`, `samples/tall-letterhead.pdf`, and `samples/no-letterhead.pdf` parse cleanly via `pdfjs-dist`, but when rendered via `@napi-rs/canvas` with our standard `disableFontFace: true` + `useSystemFonts: false` flags (per `docs/MEMO.md`), the text content is silently dropped. Only vector strokes (horizontal rules, the signature path) appear in the output. The letterhead row-scan algorithm in `src/lib/detect/letterhead.ts` therefore can't find a 3-row-thick ink band in the top 35% of these fixtures and falls back to the 18% default.
- **Context:** Group 5 (letterhead detection) integration tests against the synthetic fixtures. Manual diagnostic confirmed: a per-row scan of `tall-letterhead.pdf`'s top 35% shows only 2 rows with >0.5% ink, both at y≈27.1% (the rule under the letterhead). The rest is fully blank — the company name, address lines, and body text aren't rasterizing.
- **Root Cause:** The fixture generators (`scripts/generate-clean-letter.js`, `scripts/generate-letterhead-fixtures.js`) declare Type-1 base fonts by name (Helvetica, Times-Italic, etc.) without embedding the font program in the PDF. pdfjs in Node mode cannot fetch system fonts, so the glyphs are dropped. (In browser mode this works because pdfjs uses the host's font stack via `useSystemFonts: true`, but our rasterizer disables that for security/consistency.)
- **Fix:** **Not fixed in this group.** Algorithm correctness is verified via synthetic `Uint8ClampedArray` buffers in `src/lib/detect/letterhead.test.ts`. PDF-integration tests assert only the graceful-fallback path (returns the 18% default when no ink band is found). When samples include embedded fonts — or a real-world fixture lands in `samples/.local/` — re-enable the strict integration assertions.
- **Prevention:** Future detectors (footer in group 6, signature in group 7) should follow the same pattern: validate algorithm against synthetic buffers, treat PDF integration tests as "fallback path tolerated" until fonts embed. Long-term fix lives in a future fixture-generator update (either embed a small open-source TTF subset, or replace fixture text with vector-stroked outlines that don't need fonts).

## Common Issues to Watch For

These are documented preemptively based on the chosen tech stack. They are the things most likely to bite us; they go into the log proper if they actually happen.

### PDF rasterization (`pdfjs-dist` + `@napi-rs/canvas`)

- **`@napi-rs/canvas` missing musl prebuild on Alpine** — we deliberately use `node:20-slim` (Debian) for this reason. If anyone proposes switching to Alpine, this is why we say no.
- **`pdfjs` worker pathing in Node** — pdfjs-dist's Node usage requires setting `GlobalWorkerOptions.workerSrc` or using the `pdfjs-dist/legacy/build/pdf.mjs` entry point. Getting this wrong produces cryptic "Setting up fake worker failed" errors.
- **Encrypted PDF rejected with a misleading error** — `pdfjs.getDocument()` rejects with `PasswordException`; check the constructor name, not the message string, to surface `ENCRYPTED_PDF` cleanly.
- **Memory blow-up on 100+ page PDFs** — the 50-page cap is the defense. If we ever raise it, watch RSS during a render-all loop.

### Sharp + connected-components heuristic

- **Sharp threshold input must be a single-channel image** — call `.greyscale()` before `.threshold()` or sharp will throw at runtime, not compile time.
- **Connected-components on too-large images is slow** — we run detection on a downscaled greyscale (typically 1/2 or 1/4 res of the 200-DPI render). If detection feels slow, check the downscale factor first.
- **Sharp piped buffer not consumed** — calling `.toBuffer()` twice on the same `Sharp` instance throws. Clone with `.clone()` when running multiple pipelines.

### LibreOffice (DOCX → PDF)

- **Single-threaded per process** — concurrent `soffice` invocations can corrupt each other's profile dirs unless `-env:UserInstallation=file:///tmp/...` is per-invocation. Always pass a unique profile directory.
- **`soffice` exits 81 / 77 / etc. with no useful message** — capture stderr and log it; the exit code alone is rarely diagnostic. Wrap with `node-libreoffice-convert` or a thin custom wrapper that logs both streams.
- **`soffice` hangs on certain malformed DOCX files** — the per-job 60s timeout is the defense. If timeouts spike on one file, examine it manually.

### Tesseract (OCR)

- **Tesseract returns empty string with no error on un-readable input** — empty output is not always an error; check that we don't accidentally treat "no text found" as "OCR failed."
- **`node-tesseract-ocr` requires `tesseract` on PATH** — image built without `tesseract-ocr` apt package will fail at runtime. Healthcheck catches this.
- **`tesseract-ocr-eng` language data missing** — separate apt package from the engine. The Dockerfile installs both.

### Claude vision API (fallback)

- **Anthropic SDK requires `ANTHROPIC_API_KEY` env at construct time** — missing key throws at SDK init, not at first call. Wrap the SDK constructor in a try/catch and silently disable the fallback rather than crashing the route.
- **Vision model rate limit (`rate_limit_error`)** — back off with exponential delay; do not count rate-limited responses against the per-request budget.
- **Vision response not valid JSON** — Claude can sometimes prepend prose. Use a JSON-extraction utility that strips Markdown fences, or use the tool-use API instead of free-form JSON.

### Next.js App Router

- **Default body size limit of 1MB on App Router** — must be raised explicitly in the `route.ts` with `export const runtime = 'nodejs'` and `export const maxDuration = ...`; multipart > 1MB silently truncates otherwise.
- **SSE in App Router needs `ReadableStream` with `Content-Type: text/event-stream`** — getting headers wrong produces a "stream completed but no events received" symptom on the client.
- **`node:` built-ins in client components** — Next will error at build. Keep all `fs`, `os`, `path` usage inside `lib/` modules imported from route handlers only.

### Docker / Docker Compose

- **Slow image build on every code change** — make sure `package.json` and `package-lock.json` are copied before the rest of the source, so `npm ci` is cached.
- **`@napi-rs/canvas` not finding apt deps** — Debian-slim image needs `libfontconfig1`, `libpixman-1-0`, `libcairo2`. If `canvas` throws at runtime about missing `.so` files, this is why.
- **LibreOffice writes to `~/.config` and `/tmp` and fails as root** — run the container's Node process as a non-root user and ensure the unique `-env:UserInstallation` dir is writable by that user.

### TypeScript / build

- **`exactOptionalPropertyTypes` interaction with React props** — `prop?: string` is _not_ assignable to `prop: string | undefined`. Be explicit in component prop types.
- **`noUncheckedIndexedAccess` flags `array[0]` as `T | undefined`** — fix with explicit length checks or destructuring with a default. Don't disable the flag.

---

## Actual error entries

### [2026-05-20] pdfjs-dist renders no text when rasterizing PDFs with standard Type 1 fonts

- **Error:** Rasterized PDF pages contain only vector graphics (lines, curves) — all text is silently missing. Extracted letterhead/footer regions appear blank. Console shows `getPathGenerator - ignoring character: "Error: Requesting object that isn't resolved yet Helvetica_path_A".`
- **Context:** Server-side PDF rasterization via `pdfjs-dist` + `@napi-rs/canvas`. The sample PDFs use standard Type 1 fonts (Helvetica, Helvetica-Bold) without embedding. The `loadDocument()` call used `useSystemFonts: false`, `disableFontFace: true`, `useWorkerFetch: false`.
- **Root Cause:** Two issues: (1) `@napi-rs/canvas` does not ship with standard PDF fonts (Helvetica, etc.) registered — `pdfjs-dist` calls `ctx.font = '18px "Helvetica"'` but the canvas has no font by that name. (2) With `disableFontFace: true` and `useWorkerFetch: false`, pdfjs-dist falls back to glyph-path rendering using standard font data files (`.pfb`/`.ttf`), but these paths don't resolve in time because the standard font data factory is not configured.
- **Fix:** (a) Register the LiberationSans TTF files (shipped in `pdfjs-dist/standard_fonts/`) with `GlobalFonts.registerFromPath()` under the standard font names (Helvetica, Helvetica-Bold, etc.). (b) Pass `standardFontDataUrl` pointing to the standard_fonts directory. (c) Remove `useSystemFonts: false`, `disableFontFace: true`, `useWorkerFetch: false` from the `getDocument()` options.
- **Prevention:** Integration test `stages.test.ts` exercises real PDF rasterization. The fix also makes the test output more meaningful since the rasterized pages now contain actual text content for the detectors to analyze.

### [2026-05-20] react-pdf preview shows "Couldn't render the preview" due to worker version mismatch

- **Error:** `UnknownErrorException: The API version "5.4.296" does not match the Worker version "4.10.38".` Preview card shows error state.
- **Context:** Client-side PDF preview using `react-pdf` which depends on `pdfjs-dist@5.4.296`. The project also has a direct `pdfjs-dist@4.10.38` dependency for server-side rasterization. npm hoists `pdfjs-dist@4.10.38` to the top-level `node_modules/` and nests `5.4.296` inside `react-pdf/node_modules/`.
- **Root Cause:** The worker URL was set via `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` which Turbopack resolved to the top-level (v4) package instead of react-pdf's nested v5 copy.
- **Fix:** Copy the correct worker from `node_modules/react-pdf/node_modules/pdfjs-dist/build/pdf.worker.min.mjs` to `public/pdf.worker.min.mjs` and set `pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'`. Added a `postinstall` script to keep the file in sync.
- **Prevention:** The postinstall script ensures the worker is always the version that matches react-pdf's bundled pdfjs-dist. If react-pdf is upgraded, the worker is automatically updated on `npm install`.
