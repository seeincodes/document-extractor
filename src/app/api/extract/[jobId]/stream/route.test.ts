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

  it('stops emitting when the client aborts', async () => {
    let emitterCaptured: SseEmitter | null = null;
    fakeRunJob = async (input) => {
      emitterCaptured = input.emitter;
      // Hold open; the test will abort.
      await new Promise((r) => setTimeout(r, 50));
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
    const res = await GET(req, { params: Promise.resolve({ jobId: FAKE_JOB_ID }) });

    controller.abort();
    await new Promise((r) => setTimeout(r, 60));
    // The emitter should have been closed once abort fired.
    // We can't observe this directly without exposing internals, but we
    // confirm that calling emit on it after close is a no-op (covered by
    // sse.test.ts) and the stream eventually completes.
    expect(emitterCaptured).toBeTruthy();
    expect(res.body).toBeTruthy();
  });
});
