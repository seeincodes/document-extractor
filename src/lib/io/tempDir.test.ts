import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

import { createJobTempDir, cleanupTempDir } from './tempDir';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'extractor-test-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('createJobTempDir', () => {
  it('creates a fresh directory at <baseDir>/extractor-<jobId>', async () => {
    const path = await createJobTempDir('abc123', { baseDir });
    expect(path).toBe(join(baseDir, 'extractor-abc123'));
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(path)).toHaveLength(0);
  });

  it('returns an absolute path', async () => {
    const path = await createJobTempDir('abs', { baseDir });
    expect(isAbsolute(path)).toBe(true);
  });

  it('is idempotent: calling twice for the same jobId returns the same path without error', async () => {
    const first = await createJobTempDir('twice', { baseDir });
    const second = await createJobTempDir('twice', { baseDir });
    expect(second).toBe(first);
  });

  it('rejects job IDs containing path-traversal characters', async () => {
    for (const jobId of ['../escape', 'a/b', 'a\\b', 'a\0b', '']) {
      await expect(createJobTempDir(jobId, { baseDir })).rejects.toThrow(
        /invalid job/i,
      );
    }
  });

  it('defaults baseDir to os.tmpdir() when omitted', async () => {
    const path = await createJobTempDir('default-base');
    try {
      expect(path.startsWith(tmpdir())).toBe(true);
    } finally {
      await cleanupTempDir('default-base');
    }
  });
});

describe('cleanupTempDir', () => {
  it('removes a populated directory recursively', async () => {
    const path = await createJobTempDir('full', { baseDir });
    writeFileSync(join(path, 'a.txt'), 'hello');
    writeFileSync(join(path, 'b.bin'), Buffer.from([1, 2, 3]));

    await cleanupTempDir('full', { baseDir });
    expect(existsSync(path)).toBe(false);
  });

  it('is a no-op when the directory does not exist (idempotent)', async () => {
    await expect(
      cleanupTempDir('never-created', { baseDir }),
    ).resolves.toBeUndefined();
  });

  it('rejects job IDs containing path-traversal characters', async () => {
    for (const jobId of ['../escape', 'a/b', 'a\\b', 'a\0b', '']) {
      await expect(cleanupTempDir(jobId, { baseDir })).rejects.toThrow(
        /invalid job/i,
      );
    }
  });
});
