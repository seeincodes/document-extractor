import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';

import {
  toUserMessage,
  type ExtractErrorCode,
} from '@/lib/extract/errors';
import { getSharedJobStore } from '@/lib/extract/sharedJobStore';
import type { RegionName } from '@/lib/extract/sse';

export const runtime = 'nodejs';

const SUPPORTED_REGIONS: readonly RegionName[] = [
  'letterhead',
  'footer',
  'signature',
];

const SAFE_JOB_ID = /^[A-Za-z0-9_-]+$/;

interface RouteParams {
  params: Promise<{ jobId: string; name: string }>;
}

interface RecropBody {
  bbox: { x: number; y: number; w: number; h: number };
}

function jsonError(
  status: number,
  code: ExtractErrorCode,
  message: string,
): Response {
  return Response.json({ code, message }, { status });
}

function isRegionName(name: string): name is RegionName {
  return (SUPPORTED_REGIONS as readonly string[]).includes(name);
}

export async function POST(
  request: Request,
  ctx: RouteParams,
): Promise<Response> {
  const { jobId, name } = await ctx.params;

  if (!SAFE_JOB_ID.test(jobId)) {
    return jsonError(400, 'INVALID_JOB_ID', 'Invalid job ID.');
  }
  if (!isRegionName(name)) {
    return jsonError(
      400,
      'UNSUPPORTED_REGION',
      `Region must be one of: ${SUPPORTED_REGIONS.join(', ')}.`,
    );
  }

  const store = getSharedJobStore();
  const record = store.get(jobId);
  if (!record) {
    return jsonError(404, 'NOT_FOUND', 'Job not found or expired.');
  }

  let body: RecropBody;
  try {
    body = (await request.json()) as RecropBody;
  } catch {
    return jsonError(400, 'INTERNAL_ERROR', 'Invalid JSON body.');
  }

  const { bbox } = body;
  if (
    typeof bbox?.x !== 'number' ||
    typeof bbox?.y !== 'number' ||
    typeof bbox?.w !== 'number' ||
    typeof bbox?.h !== 'number'
  ) {
    return jsonError(400, 'INTERNAL_ERROR', 'Invalid bbox shape.');
  }

  const uploadFiles = await import('node:fs/promises').then((fs) =>
    fs.readdir(record.tempDir),
  );
  const uploadFile = uploadFiles.find((f) => f.startsWith('upload.'));
  if (!uploadFile) {
    return jsonError(500, 'INTERNAL_ERROR', toUserMessage('INTERNAL_ERROR'));
  }

  try {
    const uploadPath = join(record.tempDir, uploadFile);
    const uploadBuf = await readFile(uploadPath);

    const metadata = await sharp(uploadBuf).metadata();
    const imgWidth = metadata.width ?? 0;
    const imgHeight = metadata.height ?? 0;

    if (imgWidth <= 0 || imgHeight <= 0) {
      return jsonError(500, 'INTERNAL_ERROR', 'Could not determine image dimensions.');
    }

    const left = Math.max(0, Math.floor(bbox.x * imgWidth));
    const top = Math.max(0, Math.floor(bbox.y * imgHeight));
    const width = Math.max(1, Math.min(Math.floor(bbox.w * imgWidth), imgWidth - left));
    const height = Math.max(1, Math.min(Math.floor(bbox.h * imgHeight), imgHeight - top));

    const cropped = await sharp(uploadBuf)
      .extract({ left, top, width, height })
      .png()
      .toBuffer();

    const pngPath = join(record.tempDir, `${name}.png`);
    await writeFile(pngPath, cropped);

    const region = record.regions[name];
    if (region && region.status !== 'not_found') {
      store.update(jobId, {
        regions: {
          [name]: {
            ...region,
            bbox,
            pngPath,
          },
        },
      });
    }

    return Response.json({ ok: true, url: `/api/extract/${jobId}/region/${name}` });
  } catch {
    return jsonError(500, 'INTERNAL_ERROR', toUserMessage('INTERNAL_ERROR'));
  }
}
