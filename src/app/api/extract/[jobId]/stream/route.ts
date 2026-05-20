import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ExtractError } from '@/lib/extract/errors';
import {
  createJobStore,
  type JobStore,
} from '@/lib/extract/jobStore';
import { runJob as defaultRunJob, type RunJobInput } from '@/lib/extract/run';
import { createSseEmitter } from '@/lib/extract/sse';
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

// Module-scoped state. The upload route shares no actual store reference with
// this route yet — they each construct their own. That gap closes in group 8
// (the region-download endpoint) when we lift the JobStore into a single
// process-wide singleton. For group 4 the test override is the seam.
let store: JobStore = createJobStore();
let runJobImpl: RunJobFn = defaultRunJob;
let readUploadBytes: (jobId: string) => Promise<Uint8Array> =
  defaultReadUploadBytes;
let fileKindByJobId: (jobId: string) => SupportedKind = () => 'pdf';

const SAFE_JOB_ID = /^[A-Za-z0-9_-]+$/;

export function __resetForTests(overrides: StreamRouteOverrides = {}): void {
  store = overrides.store ?? createJobStore();
  runJobImpl = overrides.runJob ?? defaultRunJob;
  readUploadBytes = overrides.readUploadBytes ?? defaultReadUploadBytes;
  fileKindByJobId = overrides.fileKindByJobId ?? (() => 'pdf');
}

async function defaultReadUploadBytes(jobId: string): Promise<Uint8Array> {
  const record = store.get(jobId);
  if (!record) {
    throw new ExtractError('UNSUPPORTED_FILE_TYPE', `unknown job ${jobId}`);
  }
  const entries = await readdir(record.tempDir);
  const uploadFile = entries.find((name) => name.startsWith('upload.'));
  if (!uploadFile) {
    throw new ExtractError(
      'MALFORMED_PDF',
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

  const record = store.get(jobId);
  if (!record) {
    return jsonError(404, 'NOT_FOUND', 'Job not found or expired.');
  }

  const emitter = createSseEmitter();

  // Client-disconnect cleanup: close the emitter when the request aborts so
  // we don't keep generating events for nobody.
  if (request.signal) {
    const onAbort = (): void => emitter.close();
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener('abort', onAbort, { once: true });
  }

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
        // Stages are intentionally not wired yet. Group 5/6/7 will provide
        // a `defaultStages` module that this route composes. Until then the
        // override-injected runJob in tests is the only complete path.
        stages: {
          rasterize: async () => {
            throw new ExtractError(
              'MALFORMED_PDF',
              'stages not wired yet (group 5/6/7)',
            );
          },
          detectLetterhead: async () => null,
          detectFooter: async () => null,
          detectSignature: async () => null,
        },
        store,
      });
    } catch (err) {
      const code =
        err instanceof ExtractError ? err.code : 'MALFORMED_PDF';
      emitter.emit({
        event: 'error',
        data: { code, message: 'Pipeline failed before any stage ran.' },
      });
      emitter.close();
    }
  })();

  return new Response(emitter.stream, { status: 200, headers: SSE_HEADERS });
}
