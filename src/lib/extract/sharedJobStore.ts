import { createJobStore, type JobStore } from './jobStore';

// Persist the store on globalThis so it survives Next.js HMR module
// re-evaluations in dev mode. Without this, every hot-reload creates a
// fresh empty store and in-flight jobs become unreachable (404).
const g = globalThis as typeof globalThis & { __jobStore?: JobStore };

let active: JobStore = g.__jobStore ?? createJobStore();
g.__jobStore = active;

export function getSharedJobStore(): JobStore {
  return active;
}

export function __resetSharedStoreForTests(store?: JobStore): JobStore {
  active = store ?? createJobStore();
  g.__jobStore = active;
  return active;
}
