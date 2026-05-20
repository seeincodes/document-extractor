import { afterEach, describe, it, expect } from 'vitest';

import {
  __resetSharedStoreForTests,
  getSharedJobStore,
} from './sharedJobStore';

afterEach(() => {
  __resetSharedStoreForTests();
});

describe('getSharedJobStore', () => {
  it('returns the same store across calls', () => {
    const a = getSharedJobStore();
    const b = getSharedJobStore();
    expect(a).toBe(b);
  });

  it('a record created via one reference is visible via another', () => {
    // This is the exact bug the singleton fixes: one route writes, another
    // reads. Both should see the same record.
    const writerRef = getSharedJobStore();
    writerRef.create({
      jobId: 'j_singleton',
      originalFilename: 'doc.pdf',
      tempDir: '/path/to/temp',
      receivedAt: 1_700_000_000_000,
    });

    const readerRef = getSharedJobStore();
    expect(readerRef.get('j_singleton')).toBeDefined();
  });
});

describe('__resetSharedStoreForTests', () => {
  it('replaces the active store with a fresh one when called without args', () => {
    getSharedJobStore().create({
      jobId: 'j_before_reset',
      originalFilename: 'doc.pdf',
      tempDir: '/path/to/temp',
      receivedAt: 1_700_000_000_000,
    });

    __resetSharedStoreForTests();

    expect(getSharedJobStore().get('j_before_reset')).toBeUndefined();
  });

  it('swaps the active store to an injected one', () => {
    __resetSharedStoreForTests();
    const fresh = getSharedJobStore();
    fresh.create({
      jobId: 'j_in_fresh',
      originalFilename: 'doc.pdf',
      tempDir: '/path/to/temp',
      receivedAt: 1_700_000_000_000,
    });

    const replacement = __resetSharedStoreForTests();
    expect(replacement).not.toBe(fresh);
    expect(getSharedJobStore()).toBe(replacement);
    expect(getSharedJobStore().get('j_in_fresh')).toBeUndefined();
  });
});
