import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cropPageToPng } from '@/lib/extract/crop';
import { ExtractError } from '@/lib/extract/errors';
import type { JobStore } from '@/lib/extract/jobStore';
import {
  runJob as defaultRunJob,
  type MaterializeRegion,
  type RunJobInput,
} from '@/lib/extract/run';
import {
  __resetSharedStoreForTests,
  getSharedJobStore,
} from '@/lib/extract/sharedJobStore';
import { createSseEmitter } from '@/lib/extract/sse';
import { defaultStages } from '@/lib/extract/stages';
import type { SupportedKind } from '@/lib/io/validate';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

export type RunJobFn = (input: RunJobInput) => Promise<void>;

export interface StreamRouteOverrides {
  store?: JobStore;
  runJob?: RunJobFn;
  readUploadBytes?: (jobId: string) => Promise<Uint8Array>;
  fileKindByJobId?: (jobId: string) => SupportedKind;
}

let runJobImpl: RunJobFn = defaultRunJob;
let readUploadBytes: (jobId: string) => Promise<Uint8Array> =
  defaultReadUploadBytes;
let fileKindByJobId: (jobId: string) => SupportedKind = () => 'pdf';

const SAFE_JOB_ID = /^[A-Za-z0-9_-]+$/;

export function __resetForTests(overrides: StreamRouteOverrides = {}): void {
  __resetSharedStoreForTests(overrides.store);
  runJobImpl = overrides.runJob ?? defaultRunJob;
  readUploadBytes = overrides.readUploadBytes ?? defaultReadUploadBytes;
  fileKindByJobId = overrides.fileKindByJobId ?? (() => 'pdf');
}

async function defaultReadUploadBytes(jobId: string): Promise<Uint8Array> {
  // The GET handler already 404s when the JobStore has no record, so by the
  // time we get here the record must exist. If it somehow doesn't, that's an
  // INTERNAL_ERROR, not a user-input problem.
  const record = getSharedJobStore().get(jobId);
  if (!record) {
    throw new ExtractError(
      'INTERNAL_ERROR',
      `job ${jobId} disappeared between guard and read`,
    );
  }
  const entries = await readdir(record.tempDir);
  const uploadFile = entries.find((name) => name.startsWith('upload.'));
  if (!uploadFile) {
    throw new ExtractError(
      'INTERNAL_ERROR',
      `upload file missing for job ${jobId}`,
    );
  }
  return new Uint8Array(await readFile(join(record.tempDir, uploadFile)));
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

export async function GET(
  request: Request,
  ctx: RouteParams,
): Promise<Response> {
  const { jobId } = await ctx.params;

  if (!SAFE_JOB_ID.test(jobId)) {
    return jsonError(400, 'INVALID_JOB_ID', 'Invalid job ID.');
  }

  const store = getSharedJobStore();
  const record = store.get(jobId);
  if (!record) {
    return jsonError(404, 'NOT_FOUND', 'Job not found or expired.');
  }

  const emitter = createSseEmitter();

  // Client-disconnect cleanup: close the emitter when the request aborts so
  // we don't keep generating events for nobody. The listener is removed when
  // the pipeline finishes normally to avoid accumulating handlers on the
  // signal for the lifetime of the process.
  const onAbort = (): void => emitter.close();
  if (request.signal.aborted) {
    onAbort();
  } else {
    request.signal.addEventListener('abort', onAbort, { once: true });
  }
  const detachAbortListener = (): void => {
    request.signal.removeEventListener('abort', onAbort);
  };

  // Materializer that writes each detected region's crop into the per-job
  // temp dir. The runJob orchestrator calls this for every detected region
  // and patches the record's pngPath with the returned path. The region
  // download route reads the same path on subsequent GETs.
  const materializeRegion: MaterializeRegion = async (region, bbox, page) => {
    const png = await cropPageToPng(page, bbox);
    const pngPath = join(record.tempDir, `${region}.png`);
    await writeFile(pngPath, png);
    return pngPath;
  };

  // Kick off the pipeline without awaiting — the response stream is what
  // carries the work back to the client.
  void (async () => {
    try {
      const bytes = await readUploadBytes(jobId);
      const fileKind = fileKindByJobId(jobId);
      await runJobImpl({
        jobId,
        bytes,
        fileKind,
        emitter,
        stages: defaultStages,
        store,
        materializeRegion,
      });
    } catch (err) {
      const code =
        err instanceof ExtractError ? err.code : 'INTERNAL_ERROR';
      emitter.emit({
        event: 'error',
        data: { code, message: 'Pipeline failed before any stage ran.' },
      });
      emitter.close();
    } finally {
      detachAbortListener();
    }
  })();

  return new Response(emitter.stream, { status: 200, headers: SSE_HEADERS });
}
