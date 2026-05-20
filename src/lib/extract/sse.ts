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

      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
        separatorIndex = buffer.indexOf('\n\n');
      }
    }
    // Flush any trailing complete frame after the stream closes.
    const trailing = buffer + decoder.decode();
    if (trailing.includes('\n\n')) {
      const parsed = parseFrame(trailing);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}
