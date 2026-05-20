import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import type Archiver from 'archiver';

const require = createRequire(import.meta.url);
const archiver = require('archiver') as (
  format: string,
  options?: Archiver.ArchiverOptions,
) => Archiver.Archiver;

import { toUserMessage, type ExtractErrorCode } from '@/lib/extract/errors';
import { getSharedJobStore } from '@/lib/extract/sharedJobStore';
import type { JobRecord } from '@/lib/extract/jobStore';
import type { RegionName } from '@/lib/extract/sse';

export const runtime = 'nodejs';

const SAFE_BATCH_ID = /^[A-Za-z0-9_-]+$/;
const REGION_NAMES: readonly RegionName[] = ['letterhead', 'footer', 'signature'];

interface RouteParams {
  params: Promise<{ batchId: string }>;
}

function jsonError(
  status: number,
  code: ExtractErrorCode,
  message: string,
): Response {
  return Response.json({ code, message }, { status });
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function GET(
  _request: Request,
  ctx: RouteParams,
): Promise<Response> {
  const { batchId } = await ctx.params;

  if (!SAFE_BATCH_ID.test(batchId)) {
    return jsonError(400, 'INVALID_JOB_ID', 'Invalid batch ID.');
  }

  const store = getSharedJobStore();
  const batchJobs: JobRecord[] = store.listByBatch(batchId);

  if (batchJobs.length === 0) {
    return jsonError(404, 'NOT_FOUND', toUserMessage('NOT_FOUND'));
  }

  const archive = archiver('zip', { zlib: { level: 5 } });
  const chunks: Uint8Array[] = [];
  let failedJobs = 0;

  archive.on('data', (chunk: Buffer) => {
    chunks.push(new Uint8Array(chunk));
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (const job of batchJobs) {
    if (job.stage === 'failed') {
      failedJobs++;
      continue;
    }

    const dirname = sanitizeFilename(job.originalFilename);

    for (const region of REGION_NAMES) {
      const r = job.regions[region];
      if (r && r.status !== 'not_found' && r.pngPath) {
        try {
          const buf = await readFile(r.pngPath);
          archive.append(buf, {
            name: `batch-${timestamp}/${dirname}/${region}.png`,
          });
        } catch {
          // skip missing files
        }
      }
    }
  }

  await archive.finalize();
  await new Promise<void>((resolve) => archive.on('end', resolve));

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  const headers: Record<string, string> = {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="batch-${batchId}.zip"`,
  };
  if (failedJobs > 0) {
    headers['x-failed-jobs'] = String(failedJobs);
  }

  return new Response(body, { status: 200, headers });
}
