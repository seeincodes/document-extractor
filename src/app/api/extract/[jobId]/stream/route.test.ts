import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { createJobStore } from '@/lib/extract/jobStore';
import {
  parseSseStream,
  type SseEmitter,
  type SseEvent,
} from '@/lib/extract/sse';

import { GET, __resetForTests } from './route';
import type { RunJobInput } from '@/lib/extract/run';

type RunJobFn = (input: RunJobInput) => Promise<void>;

const FAKE_JOB_ID = 'j_stream_test';

let runJobCalls: RunJobInput[];
let fakeRunJob: RunJobFn;

const drain = async (
  body: ReadableStream<Uint8Array>,
): Promise<SseEvent[]> => {
  const events: SseEvent[] = [];
  for await (const e of parseSseStream(body)) events.push(e);
  return events;
};

beforeEach(() => {
  runJobCalls = [];
  fakeRunJob = async (input) => {
    runJobCalls.push(input);
    input.emitter.emit({ event: 'done', data: { jobId: input.jobId } });
    input.emitter.close();
  };

  const store = createJobStore();
  store.create({
    jobId: FAKE_JOB_ID,
    originalFilename: 'letter.pdf',
    tempDir: '/path/to/extractor-stream-test',
    receivedAt: 1_700_000_000_000,
  });
  // The route normally reads the upload bytes from disk; for the test we
  // bypass that by providing the bytes inline via a test hook.
  __resetForTests({
    store,
    runJob: fakeRunJob,
    readUploadBytes: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    fileKindByJobId: () => 'pdf',
  });
});

afterEach(() => {
  __resetForTests();
});

describe('GET /api/extract/[jobId]/stream', () => {
  it('returns 200 with text/event-stream and emits done', async () => {
    const req = new Request(
      `http://test/api/extract/${FAKE_JOB_ID}/stream`,
    );

    const res = await GET(req, { params: Promise.resolve({ jobId: FAKE_JOB_ID }) });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');

    const body = res.body;
    expect(body).toBeTruthy();
    if (!body) return;

    const events = await drain(body);
    expect(events.at(-1)).toEqual<SseEvent>({
      event: 'done',
      data: { jobId: FAKE_JOB_ID },
    });

    // The route invoked runJob with the correct jobId and a real emitter.
    expect(runJobCalls).toHaveLength(1);
    const call = runJobCalls[0];
    expect(call?.jobId).toBe(FAKE_JOB_ID);
    expect(call?.fileKind).toBe('pdf');
  });

  it('returns 404 when the jobId does not exist in the store', async () => {
    const req = new Request('http://test/api/extract/j_missing/stream');
    const res = await GET(req, { params: Promise.resolve({ jobId: 'j_missing' }) });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('returns 400 when the jobId has unsafe characters', async () => {
    const req = new Request('http://test/api/extract/..%2Fescape/stream');
    const res = await GET(req, { params: Promise.resolve({ jobId: '../escape' }) });
    expect(res.status).toBe(400);
  });

  it('propagates errors emitted by runJob into the SSE stream', async () => {
    fakeRunJob = async (input) => {
      input.emitter.emit({
        event: 'error',
        data: { code: 'ENCRYPTED_PDF', message: 'pw' },
      });
      input.emitter.close();
    };
    const store = createJobStore();
    store.create({
      jobId: FAKE_JOB_ID,
      originalFilename: 'enc.pdf',
      tempDir: '/path/to/extractor-stream-test',
      receivedAt: 1_700_000_000_000,
    });
    __resetForTests({
      store,
      runJob: fakeRunJob,
      readUploadBytes: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      fileKindByJobId: () => 'pdf',
    });

    const req = new Request(
      `http://test/api/extract/${FAKE_JOB_ID}/stream`,
    );
    const res = await GET(req, { params: Promise.resolve({ jobId: FAKE_JOB_ID }) });
    expect(res.status).toBe(200); // SSE returns 200 even on pipeline errors
    if (!res.body) throw new Error('no body');

    const events = await drain(res.body);
    expect(events[0]?.event).toBe('error');
  });

  it('closes the emitter when the client aborts mid-stream', async () => {
    const captured: { emitter: SseEmitter | null } = { emitter: null };
    const pipelineStarted = new Promise<void>((resolve) => {
      fakeRunJob = async (input) => {
        captured.emitter = input.emitter;
        resolve();
        // Hold open until aborted. The route's abort listener closes the
        // emitter; we observe that and then exit.
        await new Promise<void>((done) => {
          const tick = setInterval(() => {
            if (input.emitter.closed) {
              clearInterval(tick);
              done();
            }
          }, 5);
        });
      };
    });

    const store = createJobStore();
    store.create({
      jobId: FAKE_JOB_ID,
      originalFilename: 'letter.pdf',
      tempDir: '/path/to/extractor-stream-test',
      receivedAt: 1_700_000_000_000,
    });
    __resetForTests({
      store,
      runJob: fakeRunJob,
      readUploadBytes: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      fileKindByJobId: () => 'pdf',
    });

    const controller = new AbortController();
    const req = new Request(
      `http://test/api/extract/${FAKE_JOB_ID}/stream`,
      { signal: controller.signal },
    );
    const res = await GET(req, {
      params: Promise.resolve({ jobId: FAKE_JOB_ID }),
    });
    expect(res.status).toBe(200);

    // Wait until the pipeline has captured the emitter, then abort. If the
    // route's abort handler were removed, the emitter would never close and
    // this test would hang to Vitest's default timeout.
    await pipelineStarted;
    controller.abort();
    await new Promise((r) => setTimeout(r, 20));

    expect(captured.emitter).not.toBeNull();
    expect(captured.emitter?.closed).toBe(true);
  });
});

describe('GET /api/extract/[jobId]/stream — default stages end-to-end', () => {
  // This test exercises the real runJob + defaultStages pipeline on a real
  // PDF. No fakeRunJob override. The footer and signature detectors are
  // intentional placeholders (return null) until groups 6 and 7 land — they
  // surface as region_ready events with status: 'not_found'.
  //
  // The letterhead detector runs in 'smart' mode but the synthetic fixture
  // doesn't embed fonts, so smartScan finds no qualifying ink band and the
  // detector falls back to its default-crop result (confidence = 0.5,
  // bbox.h = 0.18). This test therefore proves the *plumbing* — the stream
  // route invokes defaultStages, the orchestrator walks every region, the
  // SSE wire format survives a real pdfjs rasterization — but it does NOT
  // prove the smart-scan algorithm produces a real detection on real input.
  // That guarantee lives in lib/detect/letterhead.test.ts on synthetic
  // buffers, and will move here once samples include embedded fonts.

  it('emits the full SSE sequence for samples/clean-letter.pdf (plumbing only)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const REAL_JOB_ID = 'j_e2e_clean';
    const samplePath = resolve(
      __dirname,
      '../../../../../../samples/clean-letter.pdf',
    );
    const bytes = new Uint8Array(readFileSync(samplePath));

    const store = createJobStore();
    store.create({
      jobId: REAL_JOB_ID,
      originalFilename: 'clean-letter.pdf',
      tempDir: '/path/to/extractor-e2e-test',
      receivedAt: 1_700_000_000_000,
    });
    __resetForTests({
      store,
      readUploadBytes: async () => bytes,
      fileKindByJobId: () => 'pdf',
    });

    const req = new Request(`http://test/api/extract/${REAL_JOB_ID}/stream`);
    const res = await GET(req, {
      params: Promise.resolve({ jobId: REAL_JOB_ID }),
    });
    expect(res.status).toBe(200);
    if (!res.body) throw new Error('no body');

    const events = await drain(res.body);
    const eventNames = events.map((e) => e.event);

    // The orchestrator must walk all three detection stages and terminate.
    expect(eventNames).toContain('stage');
    expect(eventNames).toContain('region_ready');
    expect(eventNames.at(-1)).toBe('done');

    // Letterhead and footer are implemented; signature is still a placeholder.
    const regions = events.flatMap((e) =>
      e.event === 'region_ready' ? [e.data] : [],
    );
    const letterhead = regions.find((r) => r.region === 'letterhead');
    expect(letterhead?.status).toBe('detected');
    // Pin the fallback signature so the test fails — loudly — the day the
    // fixture starts rendering fonts and smart-scan begins producing a real
    // detection. That's the cue to upgrade this assertion to expect
    // confidence > 0.5 and bbox.h in the smart-scan window.
    if (letterhead?.status === 'detected') {
      expect(letterhead.confidence).toBe(0.5);
    }

    const footer = regions.find((r) => r.region === 'footer');
    expect(footer?.status).toBe('detected');

    const signature = regions.find((r) => r.region === 'signature');
    expect(signature?.status).toBe('not_found');
  }, 15_000);
});
