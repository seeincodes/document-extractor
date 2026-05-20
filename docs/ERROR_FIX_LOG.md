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
