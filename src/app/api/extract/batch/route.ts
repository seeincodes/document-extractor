import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ExtractError,
  toUserMessage,
  type ExtractErrorCode,
} from '@/lib/extract/errors';
import { generateJobId } from '@/lib/extract/jobStore';
import { getSharedJobStore } from '@/lib/extract/sharedJobStore';
import { createJobTempDir } from '@/lib/io/tempDir';
import { validateUpload } from '@/lib/io/validate';
import { isQueueFull } from '@/lib/queue';

export const runtime = 'nodejs';
export const maxDuration = 60;

const DEFAULT_MAX_BYTES = 26_214_400;
const DEFAULT_MAX_BATCH_FILES = 10;

function errorResponse(
  status: number,
  body: { code: ExtractErrorCode; message: string },
): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (isQueueFull()) {
      return errorResponse(503, {
        code: 'SERVICE_BUSY',
        message: toUserMessage('SERVICE_BUSY'),
      });
    }

    const maxBatchFiles =
      Number(process.env['MAX_BATCH_FILES']) || DEFAULT_MAX_BATCH_FILES;

    const form = await request.formData();
    const files = form.getAll('files').filter(
      (f): f is File => f instanceof Blob && f.size > 0,
    );

    if (files.length === 0) {
      return errorResponse(400, {
        code: 'UNSUPPORTED_FILE_TYPE',
        message: 'No files provided.',
      });
    }

    if (files.length > maxBatchFiles) {
      return errorResponse(400, {
        code: 'FILE_TOO_LARGE',
        message: `Too many files. Maximum is ${maxBatchFiles}.`,
      });
    }

    const batchId = `b_${generateJobId()}`;
    const jobs: Array<{
      jobId: string;
      originalFilename: string;
      error?: { code: ExtractErrorCode; message: string };
    }> = [];

    for (const file of files) {
      const jobId = generateJobId();
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const validated = await validateUpload(bytes, {
          maxBytes: DEFAULT_MAX_BYTES,
        });
        const tempDir = await createJobTempDir(jobId);
        const uploadPath = join(tempDir, `upload.${validated.ext}`);
        await writeFile(uploadPath, bytes);

        const originalFilename =
          file instanceof File ? file.name : `upload.${validated.ext}`;

        getSharedJobStore().create({
          jobId,
          batchId,
          originalFilename,
          fileKind: validated.kind,
          tempDir,
          receivedAt: Date.now(),
        });

        jobs.push({ jobId, originalFilename });
      } catch (err) {
        const code =
          err instanceof ExtractError ? err.code : 'INTERNAL_ERROR';
        const message = toUserMessage(code);
        jobs.push({
          jobId,
          originalFilename: file instanceof File ? file.name : 'unknown',
          error: { code, message },
        });
      }
    }

    return Response.json({ batchId, jobs }, { status: 202 });
  } catch {
    return errorResponse(500, {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
  }
}
