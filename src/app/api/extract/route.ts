import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ExtractError,
  toUserMessage,
  type ExtractErrorCode,
} from '@/lib/extract/errors';
import { generateJobId } from '@/lib/extract/jobStore';
import {
  __resetSharedStoreForTests,
  getSharedJobStore,
} from '@/lib/extract/sharedJobStore';
import { createJobTempDir, cleanupTempDir } from '@/lib/io/tempDir';
import { validateUpload } from '@/lib/io/validate';
import { isQueueFull } from '@/lib/queue';

export const runtime = 'nodejs';
export const maxDuration = 60;

// 25 MB per docs/TECH_STACK.md MAX_UPLOAD_BYTES. The App Router does not
// expose a route-segment body-size config (that property lives on
// experimental.serverActions.bodySizeLimit and applies to server actions
// only), so we enforce the limit at the application layer via this constant
// and a Content-Length pre-check.
const DEFAULT_MAX_BYTES = 26_214_400;

let tempBaseDir: string | undefined;
let maxBytes: number = DEFAULT_MAX_BYTES;

export interface RouteTestOverrides {
  tempBaseDir?: string;
  maxBytes?: number;
}

export function __resetForTests(overrides: RouteTestOverrides = {}): void {
  __resetSharedStoreForTests();
  tempBaseDir = overrides.tempBaseDir;
  maxBytes = overrides.maxBytes ?? DEFAULT_MAX_BYTES;
}

interface ErrorBody {
  code: ExtractErrorCode | 'INTERNAL_ERROR';
  message: string;
}

function errorResponse(status: number, body: ErrorBody): Response {
  return Response.json(body, { status });
}

function extractErrorToResponse(err: ExtractError): Response {
  return errorResponse(400, {
    code: err.code,
    message: toUserMessage(err.code),
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (isQueueFull()) {
      return errorResponse(503, {
        code: 'SERVICE_BUSY',
        message: toUserMessage('SERVICE_BUSY'),
      });
    }

    const contentLength = request.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new ExtractError(
        'FILE_TOO_LARGE',
        `Content-Length ${contentLength} exceeds limit ${maxBytes}.`,
      );
    }

    // 2. Pull the `file` field out of the multipart body.
    const form = await request.formData();
    const fileField = form.get('file');
    if (!(fileField instanceof Blob) || fileField.size === 0) {
      throw new ExtractError(
        'UNSUPPORTED_FILE_TYPE',
        'Missing `file` field in multipart body.',
      );
    }

    const bytes = new Uint8Array(await fileField.arrayBuffer());

    // 3. Validate (size + magic-byte sniff).
    const validated = await validateUpload(bytes, { maxBytes });

    // 4. Provision the job: id → temp dir → upload.<ext> → JobRecord.
    const jobId = generateJobId();
    const tempDirOpts = tempBaseDir ? { baseDir: tempBaseDir } : {};
    const tempDir = await createJobTempDir(jobId, tempDirOpts);

    try {
      const uploadPath = join(tempDir, `upload.${validated.ext}`);
      await writeFile(uploadPath, bytes);

      const originalFilename =
        fileField instanceof File ? fileField.name : `upload.${validated.ext}`;

      getSharedJobStore().create({
        jobId,
        originalFilename,
        tempDir,
        receivedAt: Date.now(),
      });

      return Response.json({ jobId }, { status: 202 });
    } catch (err) {
      // We created a temp dir but couldn't finish provisioning the job —
      // clean up before re-throwing so the test/host doesn't leak it.
      await cleanupTempDir(jobId, tempDirOpts);
      throw err;
    }
  } catch (err) {
    if (err instanceof ExtractError) {
      return extractErrorToResponse(err);
    }
    // Anything else is a bug. Don't leak the message to the client.
    return errorResponse(500, {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
  }
}
