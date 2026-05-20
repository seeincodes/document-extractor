import { createJobStore, type JobStore } from './jobStore';

// Process-wide singleton: all routes share one JobStore so a POST that
// creates a job and a subsequent GET that reads it see the same record.
// Without this, each route's module-scoped `createJobStore()` produces
// an isolated map and the routes can't communicate.
//
// Tests swap the active store via __resetSharedStoreForTests so they run
// in isolation; production code only uses getSharedJobStore().
let active: JobStore = createJobStore();

export function getSharedJobStore(): JobStore {
  return active;
}

export function __resetSharedStoreForTests(store?: JobStore): JobStore {
  active = store ?? createJobStore();
  return active;
}
