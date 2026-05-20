import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { POST, __resetForTests } from './route';

const CLEAN_LETTER = join(
  process.cwd(),
  'samples',
  'clean-letter.pdf',
);

const buildFormData = (file: Blob, filename = 'letter.pdf'): FormData => {
  const fd = new FormData();
  fd.append('file', file, filename);
  return fd;
};

let testTempDir: string;

beforeEach(() => {
  testTempDir = mkdtempSync(join(tmpdir(), 'extractor-route-test-'));
  __resetForTests({ tempBaseDir: testTempDir });
});

afterEach(() => {
  rmSync(testTempDir, { recursive: true, force: true });
});

describe('POST /api/extract', () => {
  it('returns 202 with a jobId for a valid PDF upload', async () => {
    const bytes = readFileSync(CLEAN_LETTER);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const req = new Request('http://test/api/extract', {
      method: 'POST',
      body: buildFormData(blob, 'clean-letter.pdf'),
    });

    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toMatch(/^j_[a-z0-9]+$/);

    // The route writes the uploaded bytes into the per-job temp dir.
    const jobDir = join(testTempDir, `extractor-${body.jobId}`);
    const entries = readdirSync(jobDir);
    expect(entries).toContain('upload.pdf');
    expect(statSync(join(jobDir, 'upload.pdf')).size).toBe(bytes.byteLength);
  });

  it('returns 400 UNSUPPORTED_FILE_TYPE for a text file', async () => {
    const blob = new Blob(['not a document, just plain text\n'], {
      type: 'text/plain',
    });
    const req = new Request('http://test/api/extract', {
      method: 'POST',
      body: buildFormData(blob, 'notes.txt'),
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(body.message).toMatch(/PDF|DOCX|PNG|JPEG/);
  });

  it('returns 400 FILE_TOO_LARGE when the upload exceeds the cap', async () => {
    __resetForTests({ tempBaseDir: testTempDir, maxBytes: 100 });
    const bytes = readFileSync(CLEAN_LETTER);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const req = new Request('http://test/api/extract', {
      method: 'POST',
      body: buildFormData(blob),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('FILE_TOO_LARGE');
  });

  it('returns 400 when the multipart body has no `file` field', async () => {
    const fd = new FormData();
    fd.append('other', new Blob([]), 'x');
    const req = new Request('http://test/api/extract', {
      method: 'POST',
      body: fd,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('rejects an oversized Content-Length header without buffering the body', async () => {
    __resetForTests({ tempBaseDir: testTempDir, maxBytes: 100 });
    // We construct a request whose Content-Length advertises a body larger
    // than the cap. The route should reject based on the header alone.
    const fd = buildFormData(new Blob(['x'.repeat(10)]), 'big.pdf');
    const req = new Request('http://test/api/extract', {
      method: 'POST',
      headers: { 'content-length': '999999' },
      body: fd,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('FILE_TOO_LARGE');
  });
});
