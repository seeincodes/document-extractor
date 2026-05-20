import { readFile } from 'node:fs/promises';

import archiver from 'archiver';

import { toUserMessage, type ExtractErrorCode } from '@/lib/extract/errors';
import { getSharedJobStore } from '@/lib/extract/sharedJobStore';
import type { RegionName } from '@/lib/extract/sse';

export const runtime = 'nodejs';

const SAFE_JOB_ID = /^[A-Za-z0-9_-]+$/;
const REGION_NAMES: readonly RegionName[] = ['letterhead', 'footer', 'signature'];

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

function jsonError(
  status: number,
  code: ExtractErrorCode,
  message: string,
): Response {
  return Response.json({ code, message }, { status });
}

export async function GET(
  _request: Request,
  ctx: RouteParams,
): Promise<Response> {
  const { jobId } = await ctx.params;

  if (!SAFE_JOB_ID.test(jobId)) {
    return jsonError(400, 'INVALID_JOB_ID', 'Invalid job ID.');
  }

  const record = getSharedJobStore().get(jobId);
  if (!record) {
    return jsonError(404, 'NOT_FOUND', toUserMessage('NOT_FOUND'));
  }

  const archive = archiver('zip', { zlib: { level: 5 } });
  const chunks: Uint8Array[] = [];

  archive.on('data', (chunk: Buffer) => {
    chunks.push(new Uint8Array(chunk));
  });

  for (const region of REGION_NAMES) {
    const r = record.regions[region];
    if (r && r.status !== 'not_found' && r.pngPath) {
      try {
        const buf = await readFile(r.pngPath);
        archive.append(buf, { name: `${region}.png` });
      } catch {
        // skip missing files
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

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="regions-${jobId}.zip"`,
    },
  });
}
