import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import sharp from 'sharp';

import {
  createJobStore,
  type JobRecord,
  type JobStore,
} from '@/lib/extract/jobStore';

import { GET, __resetForTests } from './route';

const FAKE_JOB_ID = 'j_region_test';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

// A 20×20 solid white PNG. Large enough for sharp's JPEG encoder (min 2×2)
// and deterministic for the route to serve.
let testPng: Buffer;
const buildTestPng = async (): Promise<Buffer> => {
  if (testPng) return testPng;
  const rgba = new Uint8ClampedArray(20 * 20 * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 255;
    rgba[i + 1] = 255;
    rgba[i + 2] = 255;
    rgba[i + 3] = 255;
  }
  testPng = await sharp(Buffer.from(rgba), {
    raw: { width: 20, height: 20, channels: 4 },
  })
    .png()
    .toBuffer();
  return testPng;
};

const startsWith = (buf: Buffer | Uint8Array, magic: number[]): boolean => {
  for (let i = 0; i < magic.length; i++) {
    if (buf[i] !== magic[i]) return false;
  }
  return true;
};

let tempBase: string;
let store: JobStore;
let tempDir: string;

const seedJobWithRegion = (
  region: 'letterhead' | 'footer' | 'signature',
  pngPath: string,
): void => {
  const record: JobRecord = {
    jobId: FAKE_JOB_ID,
    originalFilename: 'doc.pdf',
    tempDir,
    receivedAt: 1_700_000_000_000,
    stage: 'done',
    regions: {
      [region]: {
        status: 'detected',
        bbox: { x: 0, y: 0, w: 0.5, h: 0.18 },
        pngPath,
        detector: 'heuristic',
        confidence: 0.8,
      },
    },
  };
  store.create({
    jobId: FAKE_JOB_ID,
    originalFilename: 'doc.pdf',
    tempDir,
    receivedAt: 1_700_000_000_000,
  });
  store.update(FAKE_JOB_ID, record);
};

const buildRequest = (
  name: string,
  query: Record<string, string> = {},
): { req: Request; ctx: { params: Promise<{ jobId: string; name: string }> } } => {
  const url = new URL(`http://test/api/extract/${FAKE_JOB_ID}/region/${name}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return {
    req: new Request(url),
    ctx: { params: Promise.resolve({ jobId: FAKE_JOB_ID, name }) },
  };
};

beforeEach(() => {
  tempBase = mkdtempSync(join(tmpdir(), 'extractor-region-test-'));
  tempDir = join(tempBase, `extractor-${FAKE_JOB_ID}`);
  mkdirSync(tempDir);
  store = createJobStore();
  __resetForTests({ store });
});

afterEach(() => {
  rmSync(tempBase, { recursive: true, force: true });
});

describe('GET /api/extract/[jobId]/region/[name] — PNG success', () => {
  it('serves a cached PNG with the right content-type', async () => {
    const pngPath = join(tempDir, 'letterhead.png');
    writeFileSync(pngPath, await buildTestPng());
    seedJobWithRegion('letterhead', pngPath);

    const { req, ctx } = buildRequest('letterhead');
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toMatch(/private/);

    const body = new Uint8Array(await res.arrayBuffer());
    expect(startsWith(body, PNG_MAGIC)).toBe(true);
    expect(body.byteLength).toBe((await buildTestPng()).byteLength);
  });
});

describe('GET — JPEG re-encoding', () => {
  it('returns JPEG when ?format=jpeg', async () => {
    const pngPath = join(tempDir, 'letterhead.png');
    writeFileSync(pngPath, await buildTestPng());
    seedJobWithRegion('letterhead', pngPath);

    const { req, ctx } = buildRequest('letterhead', { format: 'jpeg' });
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(startsWith(body, JPEG_MAGIC)).toBe(true);
  });

  it('passes through the quality query parameter', async () => {
    const pngPath = join(tempDir, 'letterhead.png');
    writeFileSync(pngPath, await buildTestPng());
    seedJobWithRegion('letterhead', pngPath);

    // A tiny 1x1 PNG won't show much quality variation but the route should
    // still produce a valid JPEG at quality=10.
    const { req, ctx } = buildRequest('letterhead', {
      format: 'jpeg',
      quality: '10',
    });
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('ignores ?format= values other than jpeg (defaults to PNG)', async () => {
    const pngPath = join(tempDir, 'letterhead.png');
    writeFileSync(pngPath, await buildTestPng());
    seedJobWithRegion('letterhead', pngPath);

    const { req, ctx } = buildRequest('letterhead', { format: 'webp' });
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });
});

describe('GET — error responses', () => {
  it('returns 400 for an unsafe jobId', async () => {
    const req = new Request('http://test/api/extract/..%2Fescape/region/letterhead');
    const ctx = {
      params: Promise.resolve({ jobId: '../escape', name: 'letterhead' }),
    };
    const res = await GET(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unsupported region name', async () => {
    seedJobWithRegion('letterhead', join(tempDir, 'letterhead.png'));
    const { req, ctx } = buildRequest('not-a-region');
    const res = await GET(req, ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNSUPPORTED_REGION');
  });

  it('returns 404 when the jobId does not exist', async () => {
    const req = new Request(
      'http://test/api/extract/j_missing/region/letterhead',
    );
    const ctx = {
      params: Promise.resolve({ jobId: 'j_missing', name: 'letterhead' }),
    };
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('returns 409 REGION_NOT_DETECTED when the region was not_found', async () => {
    store.create({
      jobId: FAKE_JOB_ID,
      originalFilename: 'doc.pdf',
      tempDir,
      receivedAt: 1_700_000_000_000,
    });
    store.update(FAKE_JOB_ID, {
      stage: 'done',
      regions: {
        letterhead: { status: 'not_found', reason: 'none qualified' },
      },
    });

    const { req, ctx } = buildRequest('letterhead');
    const res = await GET(req, ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('REGION_NOT_DETECTED');
  });

  it('returns 404 when a detected region has no pngPath yet (still in flight)', async () => {
    // Region detected but pngPath missing — pipeline started but materialization
    // hasn't run yet. Surface as 404 with a distinct code.
    store.create({
      jobId: FAKE_JOB_ID,
      originalFilename: 'doc.pdf',
      tempDir,
      receivedAt: 1_700_000_000_000,
    });
    store.update(FAKE_JOB_ID, {
      stage: 'detecting_signature',
      regions: {
        letterhead: {
          status: 'detected',
          bbox: { x: 0, y: 0, w: 0.5, h: 0.18 },
          detector: 'heuristic',
          confidence: 0.8,
        },
      },
    });

    const { req, ctx } = buildRequest('letterhead');
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
  });
});
