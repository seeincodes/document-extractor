import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ExtractError } from './errors';
import { createJobStore, type JobStore } from './jobStore';
import { createSseEmitter, parseSseStream, type SseEvent } from './sse';
import { runJob, type Stages } from './run';
import type { RasterizedPage } from '../rasterize/pdfjs';

const FAKE_PAGES: RasterizedPage[] = [
  {
    width: 100,
    height: 100,
    color: new Uint8ClampedArray(100 * 100 * 4),
    greyscale: new Uint8ClampedArray(100 * 100),
  },
];

const detectedRegion = (region: string) =>
  ({
    status: 'detected' as const,
    bbox: { x: 0, y: 0, w: 1, h: 0.2 },
    pngPath: `/path/to/${region}.png`,
    detector: 'heuristic' as const,
    confidence: 0.9,
  });

const stagesOk: Stages = {
  rasterize: async () => FAKE_PAGES,
  imageToPages: async () => FAKE_PAGES,
  convertDocx: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  detectLetterhead: async () => detectedRegion('letterhead'),
  detectFooter: async () => detectedRegion('footer'),
  detectSignature: async () => detectedRegion('signature'),
};

let store: JobStore;
let testTempDir: string;

beforeEach(() => {
  store = createJobStore();
  testTempDir = mkdtempSync(join(tmpdir(), 'extractor-run-test-'));
  store.create({
    jobId: 'j_run',
    originalFilename: 'letter.pdf',
    tempDir: testTempDir,
    receivedAt: 1_700_000_000_000,
  });
});

afterEach(() => {
  rmSync(testTempDir, { recursive: true, force: true });
});

const drainEvents = async (
  stream: ReadableStream<Uint8Array>,
): Promise<SseEvent[]> => {
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(stream)) {
    events.push(event);
  }
  return events;
};

describe('runJob — happy path', () => {
  it('emits stage transitions in order and ends with done', async () => {
    const emitter = createSseEmitter();
    const drain = drainEvents(emitter.stream);

    await runJob({
      jobId: 'j_run',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      fileKind: 'pdf',
      emitter,
      stages: stagesOk,
      store,
    });

    const events = await drain;
    const stageEvents = events.filter((e) => e.event === 'stage');
    const stages = stageEvents.map((e) =>
      e.event === 'stage' ? e.data.stage : null,
    );
    expect(stages).toEqual([
      'rasterizing',
      'detecting_letterhead',
      'detecting_footer',
      'detecting_signature',
    ]);

    const done = events.at(-1);
    expect(done?.event).toBe('done');
    if (done?.event === 'done') {
      expect(done.data).toEqual({ jobId: 'j_run' });
    }
  });

  it('emits one region_ready per detected region', async () => {
    const emitter = createSseEmitter();
    const drain = drainEvents(emitter.stream);

    await runJob({
      jobId: 'j_run',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      fileKind: 'pdf',
      emitter,
      stages: stagesOk,
      store,
    });

    const events = await drain;
    const regions = events
      .filter((e) => e.event === 'region_ready')
      .map((e) => (e.event === 'region_ready' ? e.data.region : null));
    expect(regions).toEqual(['letterhead', 'footer', 'signature']);
  });

  it('updates the JobStore stage at each transition and ends in `done`', async () => {
    const emitter = createSseEmitter();
    const drain = drainEvents(emitter.stream);
    await runJob({
      jobId: 'j_run',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      fileKind: 'pdf',
      emitter,
      stages: stagesOk,
      store,
    });
    await drain;

    const record = store.get('j_run');
    expect(record?.stage).toBe('done');
    expect(record?.regions.letterhead?.status).toBe('detected');
    expect(record?.regions.footer?.status).toBe('detected');
    expect(record?.regions.signature?.status).toBe('detected');
  });
});

describe('runJob — region not_found', () => {
  it('emits a region_ready with not_found when a detector returns null', async () => {
    const emitter = createSseEmitter();
    const drain = drainEvents(emitter.stream);
    const stages: Stages = {
      ...stagesOk,
      detectSignature: async () => null,
    };

    await runJob({
      jobId: 'j_run',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      fileKind: 'pdf',
      emitter,
      stages,
      store,
    });

    const events = await drain;
    const sigEvent = events.find(
      (e) => e.event === 'region_ready' && e.data.region === 'signature',
    );
    expect(sigEvent?.event).toBe('region_ready');
    if (sigEvent?.event === 'region_ready') {
      expect(sigEvent.data).toMatchObject({
        region: 'signature',
        status: 'not_found',
      });
    }

    const record = store.get('j_run');
    expect(record?.regions.signature?.status).toBe('not_found');
    expect(record?.stage).toBe('done');
  });
});

describe('runJob — error path', () => {
  it('emits an error event when a stage throws ExtractError, stops the pipeline, and marks the job failed', async () => {
    const emitter = createSseEmitter();
    const drain = drainEvents(emitter.stream);
    const stages: Stages = {
      ...stagesOk,
      rasterize: async () => {
        throw new ExtractError('ENCRYPTED_PDF', 'password-protected');
      },
    };

    await runJob({
      jobId: 'j_run',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      fileKind: 'pdf',
      emitter,
      stages,
      store,
    });

    const events = await drain;
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent?.event).toBe('error');
    if (errorEvent?.event === 'error') {
      expect(errorEvent.data.code).toBe('ENCRYPTED_PDF');
      // toUserMessage controls the body; the actual string is asserted in
      // errors.test.ts, here we just verify it isn't the raw thrown message.
      expect(errorEvent.data.message).not.toBe('password-protected');
    }

    // The pipeline must NOT continue past the failing stage.
    const stageEvents = events.filter((e) => e.event === 'stage');
    expect(stageEvents.length).toBeLessThanOrEqual(1);
    expect(events.find((e) => e.event === 'done')).toBeUndefined();

    const record = store.get('j_run');
    expect(record?.stage).toBe('failed');
    expect(record?.error?.code).toBe('ENCRYPTED_PDF');
  });

  it('translates non-ExtractError exceptions to a generic error event', async () => {
    const emitter = createSseEmitter();
    const drain = drainEvents(emitter.stream);
    const stages: Stages = {
      ...stagesOk,
      detectFooter: async () => {
        throw new TypeError('boom');
      },
    };

    await runJob({
      jobId: 'j_run',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      fileKind: 'pdf',
      emitter,
      stages,
      store,
    });

    const events = await drain;
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent?.event).toBe('error');
    // Non-ExtractError exceptions surface as INTERNAL_ERROR, never leaking
    // the raw thrown message ('boom') or class name ('TypeError') to the
    // client. The user-facing message comes from toUserMessage(INTERNAL_ERROR).
    if (errorEvent?.event === 'error') {
      expect(errorEvent.data.code).toBe('INTERNAL_ERROR');
      expect(errorEvent.data.message).not.toContain('boom');
      expect(errorEvent.data.message).not.toContain('TypeError');
    }
  });
});

describe('runJob — DOCX conversion', () => {
  it('converts DOCX via the convertDocx stage and processes normally', async () => {
    const emitter = createSseEmitter();
    const drain = drainEvents(emitter.stream);

    await runJob({
      jobId: 'j_run',
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      fileKind: 'docx',
      emitter,
      stages: stagesOk,
      store,
    });

    const events = await drain;
    const stageEvents = events.filter((e) => e.event === 'stage');
    const stages = stageEvents.map((e) =>
      e.event === 'stage' ? e.data.stage : null,
    );
    expect(stages).toContain('normalizing');
    expect(stages).toContain('rasterizing');

    const done = events.at(-1);
    expect(done?.event).toBe('done');
  });
});

describe('runJob — region materialization', () => {
  it('calls the injected materializer for each detected region and patches pngPath', async () => {
    const emitter = createSseEmitter();
    const drain = drainEvents(emitter.stream);
    const calls: Array<{ region: string; pageIndex: number }> = [];

    await runJob({
      jobId: 'j_run',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      fileKind: 'pdf',
      emitter,
      stages: stagesOk,
      store,
      materializeRegion: async (region, _bbox, _page) => {
        // We can't equality-check pages directly, but we can record the
        // region name and confirm the call happened.
        calls.push({ region, pageIndex: 0 });
        return `/tmp/fake/${region}.png`;
      },
    });
    await drain;

    expect(calls.map((c) => c.region)).toEqual([
      'letterhead',
      'footer',
      'signature',
    ]);
    const record = store.get('j_run');
    expect(record?.regions.letterhead?.status).toBe('detected');
    if (record?.regions.letterhead?.status === 'detected') {
      expect(record.regions.letterhead.pngPath).toBe('/tmp/fake/letterhead.png');
    }
  });

  it('downgrades a region to not_found when materialization throws', async () => {
    const emitter = createSseEmitter();
    const drain = drainEvents(emitter.stream);

    await runJob({
      jobId: 'j_run',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      fileKind: 'pdf',
      emitter,
      stages: stagesOk,
      store,
      materializeRegion: async (region) => {
        if (region === 'footer') {
          throw new Error('disk full');
        }
        return `/tmp/fake/${region}.png`;
      },
    });
    const events = await drain;

    // Footer should surface as not_found; letterhead and signature still
    // detected; the pipeline still terminates with done.
    const footerEvent = events.find(
      (e) => e.event === 'region_ready' && e.data.region === 'footer',
    );
    expect(footerEvent?.event).toBe('region_ready');
    if (footerEvent?.event === 'region_ready') {
      expect(footerEvent.data.status).toBe('not_found');
    }
    expect(events.at(-1)?.event).toBe('done');
  });

  it('does not call the materializer for regions that returned null', async () => {
    const emitter = createSseEmitter();
    const drain = drainEvents(emitter.stream);
    const calls: string[] = [];

    await runJob({
      jobId: 'j_run',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      fileKind: 'pdf',
      emitter,
      stages: {
        ...stagesOk,
        detectSignature: async () => null,
      },
      store,
      materializeRegion: async (region) => {
        calls.push(region);
        return `/tmp/fake/${region}.png`;
      },
    });
    await drain;

    expect(calls).not.toContain('signature');
    expect(calls).toContain('letterhead');
    expect(calls).toContain('footer');
  });
});
