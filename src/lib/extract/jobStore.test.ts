import { describe, it, expect } from 'vitest';

import {
  createJobStore,
  generateJobId,
  type NewJobInput,
} from './jobStore';

const FAKE_TEMP_DIR = '/path/to/extractor-test';

const baseInput = (overrides?: Partial<NewJobInput>): NewJobInput => ({
  jobId: 'j_test',
  originalFilename: 'letter.pdf',
  tempDir: FAKE_TEMP_DIR,
  receivedAt: 1_700_000_000_000,
  ...overrides,
});

describe('createJobStore', () => {
  it('create() inserts a record discoverable by get()', () => {
    const store = createJobStore();
    const record = store.create(baseInput({ jobId: 'j_one' }));

    expect(record.jobId).toBe('j_one');
    expect(record.stage).toBe('queued');
    expect(record.regions).toEqual({});
    expect(record.error).toBeUndefined();

    expect(store.get('j_one')).toEqual(record);
  });

  it('get() returns undefined for an unknown jobId', () => {
    const store = createJobStore();
    expect(store.get('missing')).toBeUndefined();
  });

  it('create() rejects duplicate jobIds', () => {
    const store = createJobStore();
    store.create(baseInput({ jobId: 'j_dup' }));
    expect(() => store.create(baseInput({ jobId: 'j_dup' }))).toThrow(
      /already exists/i,
    );
  });

  it('update() shallow-merges into an existing record', () => {
    const store = createJobStore();
    store.create(baseInput({ jobId: 'j_upd' }));

    const updated = store.update('j_upd', { stage: 'rasterizing' });
    expect(updated.stage).toBe('rasterizing');

    // unchanged fields survive
    expect(updated.originalFilename).toBe('letter.pdf');

    // the get() view reflects the update
    expect(store.get('j_upd')?.stage).toBe('rasterizing');
  });

  it('update() merges nested regions field by field, not by replacement', () => {
    const store = createJobStore();
    store.create(baseInput({ jobId: 'j_reg' }));

    store.update('j_reg', {
      regions: {
        letterhead: {
          status: 'detected',
          bbox: { x: 0, y: 0, w: 1, h: 0.18 },
          pngPath: '/path/to/letterhead.png',
          detector: 'heuristic',
          confidence: 0.9,
        },
      },
    });
    store.update('j_reg', {
      regions: {
        footer: {
          status: 'not_found',
          reason: 'no candidate region met confidence threshold',
        },
      },
    });

    const got = store.get('j_reg');
    expect(got?.regions.letterhead?.status).toBe('detected');
    expect(got?.regions.footer?.status).toBe('not_found');
    expect(got?.regions.signature).toBeUndefined();
  });

  it('update() throws for an unknown jobId', () => {
    const store = createJobStore();
    expect(() => store.update('missing', { stage: 'done' })).toThrow(
      /unknown job/i,
    );
  });

  it('delete() removes the record', () => {
    const store = createJobStore();
    store.create(baseInput({ jobId: 'j_del' }));
    expect(store.get('j_del')).toBeDefined();

    store.delete('j_del');
    expect(store.get('j_del')).toBeUndefined();
  });
});

describe('generateJobId', () => {
  it('produces unique values matching j_[a-z0-9]+', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = generateJobId();
      expect(id).toMatch(/^j_[a-z0-9]+$/);
      ids.add(id);
    }
    expect(ids.size).toBe(100);
  });

  it('produces ids that pass the tempDir safe-id check', () => {
    // Cross-module invariant: a generated job id must be usable as a
    // tempDir suffix. The tempDir guard is /^[A-Za-z0-9_-]+$/.
    const id = generateJobId();
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
