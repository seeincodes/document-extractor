import type { ExtractErrorCode } from './errors';
import type { JobStage } from './jobStore';

export type RegionName = 'letterhead' | 'footer' | 'signature';

export type SseEvent =
  | {
      event: 'stage';
      data: { stage: JobStage; progress: number };
    }
  | {
      event: 'region_ready';
      data:
        | {
            region: RegionName;
            status: 'detected' | 'unverified';
            detector: 'heuristic' | 'vision';
            confidence: number;
            url: string;
          }
        | {
            region: RegionName;
            status: 'not_found';
            reason: string;
          };
    }
  | {
      event: 'done';
      data: { jobId: string };
    }
  | {
      event: 'error';
      data: { code: ExtractErrorCode; message: string };
    };

export interface SseEmitter {
  stream: ReadableStream<Uint8Array>;
  emit(event: SseEvent): void;
  close(): void;
  readonly closed: boolean;
}

const ENCODER = new TextEncoder();

function formatFrame(event: SseEvent): Uint8Array {
  // EventSource wire format per WHATWG: LF terminators, `event:`/`data:`
  // prefixes, blank line between frames. JSON-encode the data payload so
  // newlines inside it don't break the frame.
  const frame = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
  return ENCODER.encode(frame);
}

export function createSseEmitter(): SseEmitter {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  return {
    stream,
    emit(event) {
      if (closed) return;
      controller.enqueue(formatFrame(event));
    },
    close() {
      if (closed) return;
      closed = true;
      controller.close();
    },
    get closed() {
      return closed;
    },
  };
}

interface RawFrame {
  event?: string;
  data?: string;
}

function parseFrame(frame: string): SseEvent | null {
  const fields: RawFrame = {};
  for (const line of frame.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon);
    // EventSource spec strips a single leading space after the colon.
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (name === 'event') fields.event = value;
    else if (name === 'data') fields.data = value;
  }
  if (!fields.event || fields.data === undefined) return null;
  // The caller controls the union; parse trusts the wire format because the
  // producer is our own emitter. A schema validator would belong here if we
  // ever consume events from a third-party source.
  return {
    event: fields.event,
    data: JSON.parse(fields.data),
  } as SseEvent;
}

function* drainFrames(buffer: string): Generator<{
  event: SseEvent;
  remaining: string;
}> {
  let rest = buffer;
  let separator = rest.indexOf('\n\n');
  while (separator !== -1) {
    const frame = rest.slice(0, separator);
    rest = rest.slice(separator + 2);
    const parsed = parseFrame(frame);
    if (parsed) yield { event: parsed, remaining: rest };
    separator = rest.indexOf('\n\n');
  }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (const drained of drainFrames(buffer)) {
        buffer = drained.remaining;
        yield drained.event;
      }
    }
    // Flush trailing complete frames after the stream closes. Multiple frames
    // can land in this final chunk if the producer flushed several events
    // without an interleaved read on our side. Buffer state doesn't matter
    // after this loop — the reader is about to be released.
    for (const drained of drainFrames(buffer + decoder.decode())) {
      yield drained.event;
    }
  } finally {
    reader.releaseLock();
  }
}
