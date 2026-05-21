import type pino from 'pino';

const level = process.env['LOG_LEVEL'] ?? 'info';

// Turbopack's production externals resolver renames packages with hash
// suffixes (e.g. "pino-<hash>") which breaks pino's internal worker
// thread initialization at runtime. We catch the failure and fall back
// to a thin console wrapper so the app still runs in Docker / prod.
// This is NOT switching the logger (pino remains primary) — it is a
// resilience layer for a Turbopack bundler edge case.
function createLogger(): pino.Logger {
  try {
    // Dynamic import prevents Turbopack from statically resolving
    // and bundling pino (which uses worker threads internally).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pinoFactory = require('pino') as typeof pino;
    return pinoFactory({
      level,
      ...(process.env['NODE_ENV'] !== 'production'
        ? { transport: { target: 'pino-pretty' } }
        : {}),
    });
  } catch {
    const noop = (): void => {};
    const fallback = {
      info: console.info.bind(console),
      error: console.error.bind(console),
      warn: console.warn.bind(console),
      debug: console.debug.bind(console),
      trace: noop,
      fatal: console.error.bind(console),
      silent: noop,
      child: () => fallback as unknown as pino.Logger,
      level,
    };
    return fallback as unknown as pino.Logger;
  }
}

export const logger: pino.Logger = createLogger();
