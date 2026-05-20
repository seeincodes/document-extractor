import type { RasterizedPage } from '../rasterize/pdfjs';
import type { SupportedKind } from '../io/validate';

import {
  ExtractError,
  toUserMessage,
  type ExtractErrorCode,
} from './errors';
import type { JobStage, JobStore, RegionResult } from './jobStore';
import type { RegionName, SseEmitter, SseEvent } from './sse';

export interface Stages {
  rasterize(bytes: Uint8Array): Promise<RasterizedPage[]>;
  detectLetterhead(
    pages: RasterizedPage[],
    jobId: string,
  ): Promise<RegionResult | null>;
  detectFooter(
    pages: RasterizedPage[],
    jobId: string,
  ): Promise<RegionResult | null>;
  detectSignature(
    pages: RasterizedPage[],
    jobId: string,
  ): Promise<RegionResult | null>;
}

export interface RunJobInput {
  jobId: string;
  bytes: Uint8Array;
  fileKind: SupportedKind;
  emitter: SseEmitter;
  stages: Stages;
  store: JobStore;
}

const PROGRESS: Record<JobStage, number> = {
  queued: 0,
  validating: 0.05,
  normalizing: 0.1,
  rasterizing: 0.25,
  detecting_letterhead: 0.5,
  detecting_footer: 0.7,
  detecting_signature: 0.9,
  done: 1,
  failed: 1,
};

export async function runJob(input: RunJobInput): Promise<void> {
  const { jobId, bytes, fileKind, emitter, stages, store } = input;

  const advance = (stage: JobStage): void => {
    store.update(jobId, { stage });
    emitter.emit({
      event: 'stage',
      data: { stage, progress: PROGRESS[stage] },
    });
  };

  const finishRegion = (
    region: RegionName,
    result: RegionResult | null,
  ): void => {
    if (!result) {
      const reason = 'no candidate region met confidence threshold';
      store.update(jobId, { regions: { [region]: { status: 'not_found', reason } } });
      emitter.emit({
        event: 'region_ready',
        data: { region, status: 'not_found', reason },
      });
      return;
    }
    store.update(jobId, { regions: { [region]: result } });
    if (result.status === 'detected' || result.status === 'unverified') {
      emitter.emit({
        event: 'region_ready',
        data: {
          region,
          status: result.status,
          detector: result.detector,
          confidence: result.confidence,
          url: `/api/extract/${jobId}/region/${region}`,
        },
      });
      return;
    }
    // status === 'not_found' from a detector that returned a typed not_found
    // result (rather than null) — surface the upstream reason.
    emitter.emit({
      event: 'region_ready',
      data: { region, status: 'not_found', reason: result.reason },
    });
  };

  try {
    if (fileKind !== 'pdf') {
      // Groups 14 (DOCX) and 15 (images) will lift this restriction.
      throw new ExtractError(
        'UNSUPPORTED_FILE_TYPE',
        `runJob does not yet support fileKind=${fileKind}`,
      );
    }

    advance('rasterizing');
    const pages = await stages.rasterize(bytes);

    advance('detecting_letterhead');
    finishRegion('letterhead', await stages.detectLetterhead(pages, jobId));

    advance('detecting_footer');
    finishRegion('footer', await stages.detectFooter(pages, jobId));

    advance('detecting_signature');
    finishRegion('signature', await stages.detectSignature(pages, jobId));

    // Terminal stage: update the store but emit `done` rather than `stage`,
    // matching the wire format in docs/USER_FLOW.md.
    store.update(jobId, { stage: 'done' });
    emitter.emit({ event: 'done', data: { jobId } });
  } catch (err) {
    const code: ExtractErrorCode =
      err instanceof ExtractError ? err.code : 'MALFORMED_PDF';
    const message = toUserMessage(code);
    store.update(jobId, { stage: 'failed', error: { code, message } });
    const errorEvent: SseEvent = {
      event: 'error',
      data: { code, message },
    };
    emitter.emit(errorEvent);
  } finally {
    emitter.close();
  }
}
