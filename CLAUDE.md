# CLAUDE.md — Document Extractor

This file is the guardrail set for AI agents (Claude Code in particular) working in this repository. It encodes decisions that the project has already made so we don't relitigate them, and it draws bright lines around things that must not change without explicit user approval.

The scaffold documentation (`docs/`) is the source of truth for _what_ this project is. This file is the source of truth for _how_ to safely work in it.

## Environment Protection

- **`.env.example` is the committed template.** It carries empty values for every variable the app reads, so a reviewer can see the variable surface area at a glance. To run locally, `cp .env.example .env` and fill in the values.
- **Never commit `.env`, `.env.local`, or any `.env.*.local` file.** All of these are gitignored. Treat their contents as secret.
- **Never display API key values in chat, logs, or commit messages.** If you need to reference one in conversation, say `ANTHROPIC_API_KEY` by name; never paste a value.
- **Never hardcode secrets.** All secrets are read from environment variables. The only "secret-shaped" string that may appear in source is a placeholder like `<your-anthropic-api-key>` in documentation.
- **Never log file contents.** Logging may include filename, size, mime type, page count, and processing metadata, but never the bytes of an uploaded document. This is part of our stateless / no-persistence stance.

## Error Logging

When you encounter or fix an error that took non-trivial time to diagnose, append an entry to `docs/ERROR_FIX_LOG.md` using the template at the top of that file.

**Log these:**

- Build failures that took more than 5 minutes to diagnose
- Runtime errors that escaped local testing
- Docker / Docker Compose failures requiring image or compose-file changes
- API errors from Anthropic (rate limits, unexpected response shapes)
- LibreOffice exit codes, Tesseract failures, pdfjs parse errors
- Deployment errors

**Do NOT log:**

- Typos and obvious syntax errors
- ESLint or Prettier warnings — fix them and move on
- Expected test failures during TDD
- Errors from intentionally malformed inputs in tests (note in test comments instead)

Each log entry must include: error message/symptom, context, root cause, fix, prevention measure.

## Tech Stack Lock

These decisions are settled. Do not switch any of them without explicit user approval. New dependencies in any of these slots require justification in the PR description.

- **Language:** TypeScript (both ends) with `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. No `any`; if an escape hatch is needed it is `unknown` plus a type guard.
- **Framework:** Next.js (App Router) — one repo, one toolchain. Do not split into separate frontend/backend packages.
- **Node runtime:** Node 20 LTS.
- **UI library:** React 19.x.
- **Styling:** Tailwind CSS v4 + shadcn/ui primitives.
- **PDF rasterization:** `pdfjs-dist` + `@napi-rs/canvas`. Do not switch to `mupdf` (AGPL), `pdf2pic` (GraphicsMagick + Ghostscript), or `node-poppler` without approval.
- **Image processing:** `sharp`. Do not introduce OpenCV native bindings or `opencv.js` for what `sharp` can already do.
- **Signature detection (primary):** `sharp` + a connected-components heuristic in TypeScript. Vision-model calls are a fallback only, triggered only when heuristic confidence is below 0.6.
- **DOCX conversion:** headless LibreOffice (`soffice`). Do not introduce `mammoth` + Chromium, `docx-preview`, or any pure-JS DOCX→image library.
- **OCR:** `node-tesseract-ocr` wrapping system Tesseract 5.x. Do not introduce `tesseract.js` (WASM) or a cloud OCR service without approval.
- **Vision API:** `@anthropic-ai/sdk` (Claude Sonnet vision). No other vision providers.
- **Queue:** `p-queue` in-process with concurrency 2 for heavy operations. Do not introduce BullMQ + Redis or any external broker.
- **Persistence:** stateless. No database, no object storage, no Redis. Temp files only, swept by a background timer. Do not add persistence without approval.
- **Logger:** `pino`. Do not switch to `winston` or `bunyan`.
- **Test runner:** Vitest for unit + integration; Playwright for the single E2E. Do not introduce Jest, Mocha, or Cypress.
- **Container base:** `node:20-slim` (Debian). Do not switch to Alpine — `@napi-rs/canvas` musl prebuilds are unreliable.
- **Orchestration:** Docker Compose v2. Single command (`docker compose up`) per the brief.

## Operational Conventions

- **Module layout** is documented in `docs/MEMO.md` ("Processing Strategy"). Route handlers in `app/api/` are thin orchestrators; all business logic lives in `lib/`.
- **No barrel files** (no `lib/extract/index.ts` re-exporting the world). Explicit imports keep the module graph traceable.
- **Error codes** are typed string constants. The full taxonomy lives in `lib/extract/errors.ts` (to be created). User-facing error messages are decoupled from error codes.
- **SSE event shapes** are documented in `docs/USER_FLOW.md` under "API Endpoints / `GET /api/extract/:jobId/stream`."
- **File-type validation is by magic bytes via `file-type`, never extension.** This is a security boundary.

## When in Doubt

- Read `docs/MEMO.md` for _why_ a decision was made.
- Read `docs/PRD.md` for _what_ the project must do.
- Read `docs/TASK_LIST.md` for _which task_ to work on next.
- Read `docs/USER_FLOW.md` for the API and UI contract.
- Read `docs/TECH_STACK.md` for the canonical list of dependencies, versions, and environment variables.
- Read `docs/ERROR_FIX_LOG.md` for any error similar to one you're hitting now.
- If something seems wrong and you're tempted to "fix it" by changing a locked technology choice — stop and ask. The decision has context that may not be obvious in the code.
