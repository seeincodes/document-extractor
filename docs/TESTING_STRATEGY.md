# Testing Strategy — Document Extractor

## Testing Pyramid

The brief lists tests as a nice-to-have ("basic tests, unit or end-to-end"). The target is a good-faith demonstration, not exhaustive coverage. Total target: ~15 tests, full suite runs in under 30 seconds.

```
                 ▲
                 │
                ╱ E2E ╲                ~7%  (1 test)
               ╱───────╲
              ╱         ╲
             ╱───────────╲              ~33% (5 tests)
            ╱ Integration ╲
           ╱───────────────╲
          ╱                 ╲
         ╱───────────────────╲
        ╱        Unit         ╲        ~60% (9 tests)
       ╱───────────────────────╲
      └─────────────────────────┘
```

Rationale: this is a backend-logic-heavy app, and most of the interesting behavior lives in the detection heuristics. Unit tests exercise the detection logic against synthetic fixtures (cheap, deterministic, fast). Integration tests cover the route handlers wired up against real sample documents (catches multipart parsing, error code surfacing, SSE plumbing). One Playwright E2E covers the happy path through the browser to prove the dropzone, preview, and download flow connect correctly.

## Coverage Targets

| Layer | Target % | Tool | Notes |
|---|---|---|---|
| `lib/detect/*` | 80%+ | Vitest + V8 coverage | Highest-value code; deterministic input → deterministic output |
| `lib/rasterize/*` | 60%+ | Vitest | Mostly thin wrappers around pdfjs; cover the public interface and error paths |
| `lib/io/*` | 80%+ | Vitest | File-type validation must be airtight (security boundary) |
| `lib/queue/*`, `lib/extract/*` | 60%+ | Vitest | Orchestration code; lower coverage acceptable, but the queue's concurrency limit is worth a dedicated test |
| `app/api/*` route handlers | covered via integration | Vitest + supertest | Don't unit-test route handlers in isolation — they're thin orchestrators |
| `lib/vision/*` | mocked | Vitest | Don't hit the real Anthropic API in tests; mock the SDK |
| `lib/convert/*`, `lib/ocr/*` | smoke only | Vitest | Real LibreOffice/Tesseract in CI is slow; one smoke test each per CI environment |
| Frontend components | not formally targeted | — | E2E covers the integration; per-component unit tests are out of scope for the time budget |

Overall line coverage target: ~70% across `lib/`. Coverage is a guideline, not a gate — we will not add tests just to hit a number.

## Test Categories

### Unit tests (Vitest)

Located under `src/lib/**/__tests__/` or `src/lib/**/*.test.ts` (colocation, not a separate `tests/` tree).

1. **Signature heuristic — clean signature** — synthetic 1000×1400 binary image with one ink blob shaped like a signature in the bottom 30%. Assert: bbox returned, confidence > 0.8.
2. **Signature heuristic — no signature** — same image with no ink in the bottom 30%. Assert: `null` returned with reason "no candidate region met confidence threshold."
3. **Signature heuristic — signature at edge** — ink blob clipped at the right edge. Assert: bbox returned with `clipped: true` flag.
4. **Signature heuristic — two signatures** — two qualifying blobs. Assert: largest one returned; the smaller one not.
5. **Signature heuristic — noisy background** — random salt-and-pepper noise + one signature blob. Assert: signature still detected after the threshold + minimum-area filter.
6. **Signature heuristic — scanned page** — fixture from a real low-DPI scan. Assert: signature detected; confidence likely < 0.6 (would trigger vision fallback in production).
7. **Cropping math** — normalized bbox `{x:0.05, y:0.82, w:0.4, h:0.1}` against a 2480×3508 page should produce pixel bbox `{x:124, y:2877, w:992, h:351}`. Assert exact math at multiple DPIs.
8. **File-type validation — PDF magic bytes** — `%PDF-1.7\n...` accepted; `.exe-as-pdf` (`MZ\x90\x00...`) rejected.
9. **File-type validation — DOCX, PNG, JPEG** — each accepted by magic bytes; mismatched extension does not affect acceptance.

### Integration tests (Vitest + supertest)

Located under `src/app/api/**/*.test.ts`. These spin up the route handler in-process and post real bytes.

10. **`POST /api/extract` happy path** — upload `samples/clean-letter.pdf`, follow the SSE stream, assert all three regions reach `region_ready`, then `done`.
11. **`POST /api/extract` rejects unsupported file** — upload a random `.txt`; assert `400 UNSUPPORTED_FILE_TYPE` with the supported-types list in the message.
12. **`POST /api/extract` rejects encrypted PDF** — upload `samples/encrypted.pdf`; assert the stream emits `error` with `code: "ENCRYPTED_PDF"`.
13. **`POST /api/extract` rejects oversize file** — upload a 26MB file; assert `400 FILE_TOO_LARGE` without parsing.
14. **`GET /api/extract/:jobId/region/:name`** — after the happy-path job completes, GET each region; assert PNG response with non-empty body and correct `Content-Type`.

### E2E test (Playwright)

15. **Upload-to-download happy path** — open the home page, drag `samples/clean-letter.pdf` onto the dropzone, wait for all three region cards to render, click "Download" on the signature card, assert the downloaded file is a non-empty PNG.

## CI Integration

CI is not part of the brief's required deliverables, but a minimal pipeline is worth setting up for credibility and self-protection during the build.

Proposed pipeline (GitHub Actions, `.github/workflows/ci.yml`):

```
on: [push, pull_request]

jobs:
  lint-types-test:
    runs-on: ubuntu-latest
    steps:
      - checkout
      - setup-node@v4 (Node 20)
      - install system deps (libreoffice-core, tesseract-ocr, tesseract-ocr-eng)
      - npm ci
      - npm run lint
      - npm run typecheck    # tsc --noEmit
      - npm run test         # Vitest unit + integration
      - npm run test:e2e     # Playwright; runs the dev server, executes the smoke test

  docker-build:
    runs-on: ubuntu-latest
    steps:
      - checkout
      - docker build -t document-extractor .
      - docker compose up -d
      - wait for /api/health to be 200
      - docker compose down
```

The `docker-build` job is the canary for any "works on my machine" issues. It explicitly does not run the test suite inside the container — that would double CI time. Instead, it verifies the image builds and the healthcheck reports OK, which is sufficient given the unit/integration tests already passed.

If time is tight during the build and CI has to be cut, the order of cuts is: `docker-build` first (re-verifiable locally), then E2E (the rest of the suite still has good coverage), never the unit/integration tests.

## Requirement Coverage Matrix

Maps PRD requirement IDs to test files / suites that cover them. A `—` means the requirement is exercised indirectly via another covered requirement.

| Requirement | Covered by | Notes |
|---|---|---|
| [MVP1] User can upload via dropzone | E2E (#15) | Drag-drop is the primary UI affordance |
| [MVP2] Validation rejects unsupported types | Unit #8, #9; Integration #11 | Magic-byte sniff plus integration-level rejection |
| [MVP3] PDF preview rendered | E2E (#15) | Assert preview canvas mounts after upload |
| [MVP4] PDF rasterized at 200 DPI | Integration #10, #14 | Indirect — the region crops being non-empty proves rasterization ran |
| [MVP5] Letterhead extracted | Integration #10, #14 | Region must be present in `done` event payload |
| [MVP6] Footer extracted | Integration #10, #14 | Same |
| [MVP7] Signature extracted via heuristic | Unit #1, #4, #5; Integration #10, #14 | Heuristic correctness covered in unit; presence covered in integration |
| [MVP8] Missing signature surfaced as `null` | Unit #2 | The heuristic returns `null` with reason |
| [MVP9] All three regions render in UI | E2E (#15) | Cards must mount; image elements must have non-empty `src` |
| [MVP10] Per-region download | E2E (#15); Integration #14 | E2E clicks download, integration verifies the bytes |
| [MVP11] Graceful error handling | Integration #11, #12, #13 | One test per error class |
| [MVP12] `docker compose up` works | `docker-build` CI job | Local verification before submission |
| [MVP13] Sample doc exercises pipeline | Integration #10 fixture | The sample doc IS the integration fixture |
| [FS1] Vision fallback < 0.6 confidence | Mocked unit test on `lib/vision/claude.ts` | Mock the SDK; assert call shape; not in the count of 15 |
| [FS2] Vision budget enforced | Mocked unit test on budget tracker | Out of the count of 15; nice-to-have if time permits |
| [FS3] UI shows detector badge | E2E (#15) extension if time permits | Optional |
| [FS4] DOCX support | Integration smoke test if LibreOffice present in CI | Beyond the count of 15 |
| [FS5] PNG/JPEG inputs | Unit fixture test on the image-input code path | Beyond the count of 15 |
| [FS7] OCR fallback on scanned PDFs | Integration smoke if Tesseract present | Beyond the count of 15 |
| [FS8]–[FS9] Adjustable crop UI | Manual / E2E extension | Not in the formal test count |
| [FS10]–[FS13] Batch upload + ZIP | Integration test on `/api/extract/batch` | If time permits |
| [FS14] JPEG/quality query param | Integration extension on #14 | Quick add if time permits |
| [FS15]–[FS17] Tests | This document | Self-referential — the tests prove the tests exist |
| [FS18] Healthcheck endpoint | Integration test on `/api/health` | If time permits |
| [FS19] Structured pino logs | Not formally tested | Manual verification |
