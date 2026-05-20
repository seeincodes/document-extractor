import { readFile } from 'node:fs/promises';

import { pngToJpeg } from '@/lib/extract/crop';
import {
  toUserMessage,
  type ExtractErrorCode,
} from '@/lib/extract/errors';
import { createJobStore, type JobStore } from '@/lib/extract/jobStore';
import type { RegionName } from '@/lib/extract/sse';

export const runtime = 'nodejs';

const SUPPORTED_REGIONS: readonly RegionName[] = [
  'letterhead',
  'footer',
  'signature',
];

const SAFE_JOB_ID = /^[A-Za-z0-9_-]+$/;

// Crops live in the per-job temp dir for the dir's full lifetime (10 min by
// default). The URL is uniquely tied to (jobId, region, format/quality), so
// the response is safe to cache as immutable for the temp-dir TTL.
const PNG_CACHE_CONTROL = 'private, max-age=600, immutable';
const JPEG_CACHE_CONTROL = 'private, max-age=600, immutable';

interface RouteParams {
  params: Promise<{ jobId: string; name: string }>;
}

export interface RegionRouteOverrides {
  store?: JobStore;
}

// Module-scoped store. The same JobStore must be shared with the stream
// route + upload route in production; that single-process singleton lands
// in a later group. For now the override-injected store in tests is what
// lets the suite run in isolation.
let store: JobStore = createJobStore();

export function __resetForTests(overrides: RegionRouteOverrides = {}): void {
  store = overrides.store ?? createJobStore();
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

export async function GET(
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

  const record = store.get(jobId);
  if (!record) {
    return jsonError(404, 'NOT_FOUND', 'Job not found or expired.');
  }

  const region = record.regions[name];
  if (!region) {
    return jsonError(
      404,
      'NOT_FOUND',
      'Region not yet processed for this job.',
    );
  }
  if (region.status === 'not_found') {
    return jsonError(
      409,
      'REGION_NOT_DETECTED',
      toUserMessage('REGION_NOT_DETECTED'),
    );
  }
  if (!region.pngPath) {
    // Detected but not yet materialized — the orchestrator is still in
    // flight or the materializer skipped this region.
    return jsonError(404, 'NOT_FOUND', 'Region crop not yet available.');
  }

  // Read the cached PNG. If reading fails (file expired, disk error), surface
  // as 500 — the route doesn't try to recompute from raw pixels.
  let png: Buffer;
  try {
    png = await readFile(region.pngPath);
  } catch {
    return jsonError(500, 'INTERNAL_ERROR', toUserMessage('INTERNAL_ERROR'));
  }

  const url = new URL(request.url);
  const format = url.searchParams.get('format');
  if (format === 'jpeg') {
    const qualityParam = url.searchParams.get('quality');
    const quality =
      qualityParam !== null && qualityParam !== ''
        ? Number(qualityParam)
        : undefined;
    try {
      const jpeg = await pngToJpeg(png, quality ?? 85);
      return new Response(new Uint8Array(jpeg), {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'cache-control': JPEG_CACHE_CONTROL,
        },
      });
    } catch {
      return jsonError(500, 'INTERNAL_ERROR', toUserMessage('INTERNAL_ERROR'));
    }
  }

  return new Response(new Uint8Array(png), {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'cache-control': PNG_CACHE_CONTROL,
    },
  });
}
