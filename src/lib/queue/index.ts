import PQueue from 'p-queue';

const DEFAULT_HEAVY_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUE_DEPTH = 10;

const heavyConcurrency =
  Number(process.env['HEAVY_CONCURRENCY']) || DEFAULT_HEAVY_CONCURRENCY;
const maxQueueDepth =
  Number(process.env['MAX_QUEUE_DEPTH']) || DEFAULT_MAX_QUEUE_DEPTH;

export const heavyQueue = new PQueue({ concurrency: heavyConcurrency });

export function isQueueFull(): boolean {
  return heavyQueue.size + heavyQueue.pending >= maxQueueDepth;
}
