import { describe, it, expect } from 'vitest';

import {
  createSseEmitter,
  parseSseStream,
  type SseEvent,
} from './sse';

const collectAll = async (
  stream: ReadableStream<Uint8Array>,
): Promise<SseEvent[]> => {
  const out: SseEvent[] = [];
  for await (const event of parseSseStream(stream)) {
    out.push(event);
  }
  return out;
};

describe('createSseEmitter + parseSseStream round-trip', () => {
  it('emits a stage event with the right shape', async () => {
    const emitter = createSseEmitter();
    emitter.emit({
      event: 'stage',
      data: { stage: 'rasterizing', progress: 0.33 },
    });
    emitter.close();

    const events = await collectAll(emitter.stream);
    expect(events).toEqual<SseEvent[]>([
      { event: 'stage', data: { stage: 'rasterizing', progress: 0.33 } },
    ]);
  });

  it('emits a region_ready event for a detected region', async () => {
    const emitter = createSseEmitter();
    emitter.emit({
      event: 'region_ready',
      data: {
        region: 'letterhead',
        status: 'detected',
        detector: 'heuristic',
        confidence: 0.92,
        url: '/api/extract/j_abc/region/letterhead',
      },
    });
    emitter.close();

    const events = await collectAll(emitter.stream);
    expect(events).toHaveLength(1);
    const first = events[0];
    expect(first?.event).toBe('region_ready');
    expect(first?.data).toMatchObject({
      region: 'letterhead',
      status: 'detected',
      detector: 'heuristic',
    });
  });

  it('emits a region_ready event with a not_found payload', async () => {
    const emitter = createSseEmitter();
    emitter.emit({
      event: 'region_ready',
      data: {
        region: 'signature',
        status: 'not_found',
        reason: 'no candidate region met confidence threshold',
      },
    });
    emitter.close();

    const events = await collectAll(emitter.stream);
    expect(events[0]?.data).toEqual({
      region: 'signature',
      status: 'not_found',
      reason: 'no candidate region met confidence threshold',
    });
  });

  it('emits a done event with the jobId', async () => {
    const emitter = createSseEmitter();
    emitter.emit({ event: 'done', data: { jobId: 'j_abc' } });
    emitter.close();

    const events = await collectAll(emitter.stream);
    expect(events).toEqual<SseEvent[]>([
      { event: 'done', data: { jobId: 'j_abc' } },
    ]);
  });

  it('emits an error event with code and message', async () => {
    const emitter = createSseEmitter();
    emitter.emit({
      event: 'error',
      data: { code: 'ENCRYPTED_PDF', message: 'password-protected' },
    });
    emitter.close();

    const events = await collectAll(emitter.stream);
    expect(events).toEqual<SseEvent[]>([
      {
        event: 'error',
        data: { code: 'ENCRYPTED_PDF', message: 'password-protected' },
      },
    ]);
  });

  it('emits a sequence of events in order', async () => {
    const emitter = createSseEmitter();
    emitter.emit({
      event: 'stage',
      data: { stage: 'validating', progress: 1.0 },
    });
    emitter.emit({
      event: 'stage',
      data: { stage: 'rasterizing', progress: 0.5 },
    });
    emitter.emit({ event: 'done', data: { jobId: 'j_seq' } });
    emitter.close();

    const events = await collectAll(emitter.stream);
    const eventNames = events.map((e) => e.event);
    expect(eventNames).toEqual(['stage', 'stage', 'done']);
  });

  it('close() terminates the consumer loop without emitting extra events', async () => {
    const emitter = createSseEmitter();
    emitter.emit({ event: 'done', data: { jobId: 'j_close' } });
    emitter.close();

    let iterations = 0;
    for await (const _event of parseSseStream(emitter.stream)) {
      iterations++;
      // The parser must not yield phantom events after close().
      if (iterations > 5) break;
    }
    expect(iterations).toBe(1);
  });
});

describe('SSE wire format', () => {
  it('uses LF terminators and the event:/data: prefix convention', async () => {
    const emitter = createSseEmitter();
    emitter.emit({
      event: 'stage',
      data: { stage: 'validating', progress: 1 },
    });
    emitter.close();

    const reader = emitter.stream.getReader();
    let raw = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += new TextDecoder().decode(value);
    }

    // Exact expected wire format:
    //   event: stage\n
    //   data: {"stage":"validating","progress":1}\n
    //   \n
    expect(raw).toBe(
      'event: stage\ndata: {"stage":"validating","progress":1}\n\n',
    );
    // No CRLF anywhere — per the WHATWG EventSource spec.
    expect(raw.includes('\r')).toBe(false);
  });
});

describe('parseSseStream chunking', () => {
  it('parses an event delivered in two arbitrary chunks', async () => {
    // Simulate a server that flushes in the middle of an event payload —
    // the parser must buffer across chunk boundaries.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: stage\ndata: {"stag'));
        controller.enqueue(new TextEncoder().encode('e":"done","progress":1}\n\n'));
        controller.close();
      },
    });

    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }

    expect(events).toEqual<SseEvent[]>([
      { event: 'stage', data: { stage: 'done', progress: 1 } },
    ]);
  });
});
