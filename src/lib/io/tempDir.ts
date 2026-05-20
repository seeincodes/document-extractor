import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempDirOptions {
  baseDir?: string;
}

// Allowed: alphanumerics, dash, underscore. Anything else (slashes, dots,
// null bytes, empty) is a security boundary — we never let an attacker
// influence the path we touch on disk.
const SAFE_JOB_ID = /^[A-Za-z0-9_-]+$/;

function jobDir(jobId: string, opts: TempDirOptions): string {
  if (!SAFE_JOB_ID.test(jobId)) {
    throw new Error(`Invalid job ID: ${JSON.stringify(jobId)}`);
  }
  return join(opts.baseDir ?? tmpdir(), `extractor-${jobId}`);
}

export async function createJobTempDir(
  jobId: string,
  opts: TempDirOptions = {},
): Promise<string> {
  const path = jobDir(jobId, opts);
  await mkdir(path, { recursive: true });
  return path;
}

export async function cleanupTempDir(
  jobId: string,
  opts: TempDirOptions = {},
): Promise<void> {
  const path = jobDir(jobId, opts);
  await rm(path, { recursive: true, force: true });
}
