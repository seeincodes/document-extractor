import { randomBytes } from 'node:crypto';

import type { ExtractErrorCode } from './errors';

export type JobStage =
  | 'queued'
  | 'validating'
  | 'normalizing'
  | 'rasterizing'
  | 'detecting_letterhead'
  | 'detecting_footer'
  | 'detecting_signature'
  | 'done'
  | 'failed';

export interface NormalizedBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// `pngPath` is optional because detection happens before materialization:
// the detector produces a bbox + metadata; the orchestrator (or group 8's
// crop step) writes the PNG to disk and patches the record with the path.
// While the field is absent the record represents a detected-but-not-yet-
// cropped region.
export type RegionResult =
  | {
      status: 'detected';
      bbox: NormalizedBBox;
      pngPath?: string;
      detector: 'heuristic' | 'vision';
      confidence: number;
      // Free-form context about the detection. The footer detector uses this
      // to record that the same band appears on N total pages — a hint the
      // UI can surface to distinguish a single-page footer from a recurring
      // page-number band.
      note?: string;
    }
  | { status: 'not_found'; reason: string }
  | {
      status: 'unverified';
      bbox: NormalizedBBox;
      pngPath?: string;
      detector: 'heuristic';
      confidence: number;
      reason: string;
    };

export interface JobRecord {
  jobId: string;
  batchId?: string;
  originalFilename: string;
  receivedAt: number;
  stage: JobStage;
  tempDir: string;
  regions: {
    letterhead?: RegionResult;
    footer?: RegionResult;
    signature?: RegionResult;
  };
  error?: { code: ExtractErrorCode; message: string };
}

export interface NewJobInput {
  jobId: string;
  batchId?: string;
  originalFilename: string;
  tempDir: string;
  receivedAt: number;
}

export interface JobStore {
  create(input: NewJobInput): JobRecord;
  get(jobId: string): JobRecord | undefined;
  update(jobId: string, patch: Partial<JobRecord>): JobRecord;
  delete(jobId: string): void;
}

export function createJobStore(): JobStore {
  const records = new Map<string, JobRecord>();

  return {
    create(input) {
      if (records.has(input.jobId)) {
        throw new Error(`Job ${input.jobId} already exists`);
      }
      const record: JobRecord = {
        ...input,
        stage: 'queued',
        regions: {},
      };
      records.set(input.jobId, record);
      return record;
    },

    get(jobId) {
      return records.get(jobId);
    },

    update(jobId, patch) {
      const existing = records.get(jobId);
      if (!existing) {
        throw new Error(`Unknown job ${jobId}`);
      }
      // Shallow merge at the top level, but `regions` is a nested object
      // that callers expect to merge field-by-field (letterhead doesn't get
      // erased when footer is added). Everything else replaces.
      const next: JobRecord = {
        ...existing,
        ...patch,
        regions: { ...existing.regions, ...(patch.regions ?? {}) },
      };
      records.set(jobId, next);
      return next;
    },

    delete(jobId) {
      records.delete(jobId);
    },
  };
}

export function generateJobId(): string {
  // 18 bytes → 36 hex chars. Collision risk is negligible at our scale,
  // and the prefix makes the id immediately recognizable in logs.
  return `j_${randomBytes(18).toString('hex')}`;
}
