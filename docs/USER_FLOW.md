# User Flow — Document Extractor

## Primary Flow

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Step 1: Land on home page                                            t=0s │
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │   Document Extractor                                              │    │
│  │   Drop a PDF, DOCX, or image here — or click to choose            │    │
│  │   ┌─────────────────────────────────────────────────────────┐     │    │
│  │   │            [   drop zone — react-dropzone   ]           │     │    │
│  │   │                                                         │     │    │
│  │   │            up to 10 files, 25 MB each                   │     │    │
│  │   └─────────────────────────────────────────────────────────┘     │    │
│  └───────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ drag/drop or click → select file(s)
                                  ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Step 2: Client-side validation                                  t≈0–100ms │
│                                                                           │
│  • Check extension and size before upload                                 │
│  • If invalid: show inline error in dropzone, do not POST                 │
│  • If valid: start upload                                                 │
└───────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ POST /api/extract (multipart)
                                  ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Step 3: Server returns jobId, client opens SSE                  t≈100ms   │
│                                                                           │
│  POST returns { jobId } as soon as the upload is received                 │
│  Client opens GET /api/extract/:jobId/stream (SSE)                        │
│                                                                           │
│  PDF preview begins rendering in parallel via react-pdf                   │
└───────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ SSE events arrive
                                  ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Step 4: Progress UI updates in real time                       t=0.1–15s │
│                                                                           │
│  ┌───────────────────────────────┬───────────────────────────────────┐    │
│  │ PDF Preview                   │ Extraction progress               │    │
│  │  (react-pdf, scrollable)      │   ▣ validating ............ ✓     │    │
│  │                               │   ▣ rasterizing .............33%  │    │
│  │   [page 1]                    │   □ letterhead                    │    │
│  │   [page 2]                    │   □ footer                        │    │
│  │   [page 3]                    │   □ signature                     │    │
│  │                               │                                   │    │
│  └───────────────────────────────┴───────────────────────────────────┘    │
│                                                                           │
│  As each region finishes (SSE `region_ready` event):                      │
│                                                                           │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────┐    │
│  │ Letterhead          │  │ Footer              │  │ Signature       │    │
│  │ [auto-crop preview] │  │ [auto-crop preview] │  │ [crop preview]  │    │
│  │  detected: heuristic│  │  detected: heuristic│  │  verified: 🅥   │    │
│  │  [Adjust] [Download]│  │  [Adjust] [Download]│  │  [Adjust] [⬇]   │    │
│  └─────────────────────┘  └─────────────────────┘  └─────────────────┘    │
│                                                                           │
│  If signature can't be detected:                                          │
│   ┌─────────────────────────────────────────────────────────┐             │
│   │ Signature                                               │             │
│   │  No signature detected on the bottom 30% of the last    │             │
│   │  page.                                                  │             │
│   │  [Adjust manually]                                      │             │
│   └─────────────────────────────────────────────────────────┘             │
└───────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ user clicks Download or Adjust
                                  ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Step 5a: Download                                                         │
│   GET /api/extract/:jobId/region/:name                                    │
│   → browser saves PNG (default) or JPEG (?format=jpeg&quality=85)         │
│                                                                           │
│ Step 5b: Adjust then download                                             │
│   User drags crop handles in react-easy-crop                              │
│   POST /api/extract/:jobId/recrop/:name { bbox } → new PNG path           │
│   GET /api/extract/:jobId/region/:name (revalidated) → download           │
│                                                                           │
│ Step 5c: Download all as ZIP (single doc)                                 │
│   GET /api/extract/:jobId/zip → all detected regions in one archive       │
└───────────────────────────────────────────────────────────────────────────┘

──────────────────────────────────────────────────────────────────────────────

Batch flow (≤ 10 files):

┌───────────────────────────────────────────────────────────────────────────┐
│  Multi-doc table view replaces the single-doc preview pane:               │
│                                                                           │
│  ┌──────────────────┬──────────────────┬──────────────┬─────────────────┐ │
│  │ File             │ Status           │ Regions      │ Download        │ │
│  ├──────────────────┼──────────────────┼──────────────┼─────────────────┤ │
│  │ letter-a.pdf     │ ✓ done           │ L F S        │ [⬇ ZIP]         │ │
│  │ contract.docx    │ converting       │ —            │ —               │ │
│  │ scan.pdf         │ ocr fallback     │ L            │ —               │ │
│  │ corrupt.pdf      │ ✗ MALFORMED_PDF  │ —            │ —               │ │
│  └──────────────────┴──────────────────┴──────────────┴─────────────────┘ │
│                                                                           │
│  [⬇ Download all regions as ZIP]                                          │
│   → GET /api/extract/batch/:batchId/zip                                   │
│   → archive layout: batch-{timestamp}/{original-filename}/{region}.png    │
└───────────────────────────────────────────────────────────────────────────┘
```

## API Endpoints

### `POST /api/extract`

**Request:** `multipart/form-data`

- `file` — single document (PDF, DOCX, PNG, JPEG, etc.)

**Response (202 Accepted):**

```json
{ "jobId": "j_8f3a2c..." }
```

**Errors (immediate, before processing):**

- `400 UNSUPPORTED_FILE_TYPE` — magic-byte sniff failed
- `400 FILE_TOO_LARGE` — body > `MAX_UPLOAD_BYTES`
- `503 SERVICE_BUSY` — queue depth > `MAX_QUEUE_DEPTH`

### `GET /api/extract/:jobId/stream`

**Response:** `text/event-stream`. One event per stage transition:

```
event: stage
data: {"stage":"validating","progress":1.0}

event: stage
data: {"stage":"rasterizing","progress":0.33}

event: region_ready
data: {"region":"letterhead","detector":"heuristic","confidence":0.92,"url":"/api/extract/j_8f3a2c.../region/letterhead"}

event: region_ready
data: {"region":"signature","detector":"vision","confidence":0.95,"url":"/api/extract/j_8f3a2c.../region/signature"}

event: done
data: {"jobId":"j_8f3a2c..."}
```

**Errors during processing emit:**

```
event: error
data: {"code":"ENCRYPTED_PDF","message":"This PDF is password-protected. We don't support encrypted files."}
```

### `GET /api/extract/:jobId/region/:name`

**Path params:** `name` ∈ `letterhead | footer | signature`
**Query params:** `format=png|jpeg` (default `png`), `quality=1..100` (default 85, JPEG only)
**Response:** binary image with `Content-Type: image/png` or `image/jpeg`

**Errors:**

- `404 NOT_FOUND` — jobId expired or region not detected
- `409 REGION_NOT_DETECTED` — job completed but this region had no detection

### `POST /api/extract/:jobId/recrop/:name`

**Request:** `application/json`

```json
{ "bbox": { "x": 0.05, "y": 0.82, "w": 0.4, "h": 0.1 } }
```

All bbox values are normalized 0..1 relative to the source page.

**Response (200 OK):**

```json
{ "url": "/api/extract/j_8f3a2c.../region/signature" }
```

### `POST /api/extract/batch`

**Request:** `multipart/form-data` with up to `MAX_BATCH_FILES` files
**Response (202 Accepted):**

```json
{
  "batchId": "b_2a1f...",
  "jobs": [
    { "jobId": "j_aa...", "filename": "letter-a.pdf" },
    { "jobId": "j_bb...", "filename": "contract.docx" }
  ]
}
```

Each job streams independently via its own `/stream` endpoint.

### `GET /api/extract/batch/:batchId/zip`

**Response:** `application/zip`. Archive layout:

```
batch-2026-05-20T10-15-30Z/
  letter-a.pdf/
    letterhead.png
    footer.png
    signature.png
  contract.docx/
    letterhead.png
    footer.png
```

Failed jobs are omitted from the archive; the response includes an `X-Failed-Jobs` header listing their job IDs.

### `GET /api/health`

**Response (200 OK):**

```json
{
  "status": "ok",
  "libreoffice": true,
  "tesseract": true,
  "freeDiskMB": 4128,
  "queueDepth": 0,
  "uptimeSeconds": 3421
}
```

Returns `503` with the same shape (and `status: "degraded"` or `status: "down"`) when something is unhealthy. The Docker healthcheck runs this every 30 seconds.

## Example Queries

| Query                                             | Expected Result                                                                                              | Expected Answer                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Upload `samples/clean-letter.pdf`                 | All three regions detected via heuristic                                                                     | Letterhead is the top banner, footer is the bottom address line, signature is the largest connected component on the bottom of page 1 |
| Upload `samples/multi-page-report.pdf`            | Letterhead from page 1, footer from last page (with note "same region appears on all N pages"), no signature | Signature reads `null` with reason "no candidate region met confidence threshold"                                                     |
| Upload `samples/scanned-letter.pdf`               | All three regions detected; signature confidence < 0.6 so vision fallback runs (if `ANTHROPIC_API_KEY` set)  | Letterhead + footer use the row-scan boundary detector against the OCR'd text mask; signature shows `verified: vision` badge          |
| Upload `samples/letter.docx`                      | LibreOffice converts to PDF, then the standard pipeline runs                                                 | All three regions extracted exactly as if the source were a PDF                                                                       |
| Upload an encrypted PDF                           | Job fails at validation stage                                                                                | SSE emits `{ code: "ENCRYPTED_PDF", message: "This PDF is password-protected..." }`                                                   |
| Upload a `.exe` renamed to `.pdf`                 | Magic-byte sniff rejects before any parser runs                                                              | `400 UNSUPPORTED_FILE_TYPE` with list of supported types                                                                              |
| Upload a 60-page PDF                              | Pre-rasterization check rejects                                                                              | `PAGE_LIMIT_EXCEEDED` with "max 50 pages per document"                                                                                |
| Upload 12 files in one batch                      | Server rejects with batch-size error                                                                         | `400 BATCH_LIMIT_EXCEEDED` ("max 10 files per batch")                                                                                 |
| Request `?format=jpeg&quality=70` on a letterhead | Server re-encodes from the original color buffer                                                             | JPEG at quality 70, smaller file, slightly lossy                                                                                      |
| Adjust the signature crop and re-download         | User drags the bbox, POSTs `/recrop`, server returns a new PNG                                               | New PNG reflects the adjusted bbox; original is overwritten in the temp dir                                                           |
