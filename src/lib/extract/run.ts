import type { RasterizedPage } from '../rasterize/pdfjs';
import type { SupportedKind } from '../io/validate';

import {
  ExtractError,
  toUserMessage,
  type ExtractErrorCode,
} from './errors';
import type {
  JobStage,
  JobStore,
  NormalizedBBox,
  RegionResult,
} from './jobStore';
import type { RegionName, SseEmitter, SseEvent } from './sse';

// Writes a region's crop to disk and returns the absolute path. Injected via
// RunJobInput so the route handler can supply the production implementation
// (which uses lib/extract/crop.ts + the per-job temp dir) while tests can
// substitute a fake that returns a deterministic path.
export type MaterializeRegion = (
  region: RegionName,
  bbox: NormalizedBBox,
  page: RasterizedPage,
) => Promise<string>;

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
  // Optional: writes a region's crop to disk and returns the path. When
  // absent, regions are detected but no PNG is written — useful for the
  // dev/test paths where the route's materializer hasn't been wired yet.
  materializeRegion?: MaterializeRegion;
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

// Which page of the document each region's bbox refers to. Letterhead is
// always on page 1; footer and signature are on the last page (per the
// MEMO's Stage 4 design).
function pageForRegion(
  region: RegionName,
  pages: RasterizedPage[],
): RasterizedPage | undefined {
  if (region === 'letterhead') return pages[0];
  return pages.at(-1);
}

export async function runJob(input: RunJobInput): Promise<void> {
  const { jobId, bytes, fileKind, emitter, stages, store, materializeRegion } =
    input;

  const advance = (stage: JobStage): void => {
    store.update(jobId, { stage });
    emitter.emit({
      event: 'stage',
      data: { stage, progress: PROGRESS[stage] },
    });
  };

  const emitNotFound = (region: RegionName, reason: string): void => {
    store.update(jobId, { regions: { [region]: { status: 'not_found', reason } } });
    emitter.emit({
      event: 'region_ready',
      data: { region, status: 'not_found', reason },
    });
  };

  const finishRegion = async (
    region: RegionName,
    result: RegionResult | null,
    pages: RasterizedPage[],
  ): Promise<void> => {
    if (!result) {
      emitNotFound(region, 'no candidate region met confidence threshold');
      return;
    }
    if (result.status === 'not_found') {
      emitNotFound(region, result.reason);
      return;
    }

    // Materialize the crop to disk if a materializer was provided. A failure
    // here downgrades the region to not_found rather than killing the job —
    // a missing crop is a soft failure the UI can render distinctly.
    let materialized = result;
    if (materializeRegion) {
      const page = pageForRegion(region, pages);
      if (!page) {
        emitNotFound(region, 'no page available to crop from');
        return;
      }
      try {
        const pngPath = await materializeRegion(region, result.bbox, page);
        materialized = { ...result, pngPath };
      } catch {
        emitNotFound(region, 'failed to materialize region crop');
        return;
      }
    }

    store.update(jobId, { regions: { [region]: materialized } });
    emitter.emit({
      event: 'region_ready',
      data: {
        region,
        status: materialized.status,
        detector: materialized.detector,
        confidence: materialized.confidence,
        url: `/api/extract/${jobId}/region/${region}`,
      },
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
    await finishRegion(
      'letterhead',
      await stages.detectLetterhead(pages, jobId),
      pages,
    );

    advance('detecting_footer');
    await finishRegion(
      'footer',
      await stages.detectFooter(pages, jobId),
      pages,
    );

    advance('detecting_signature');
    await finishRegion(
      'signature',
      await stages.detectSignature(pages, jobId),
      pages,
    );

    // Terminal stage: update the store but emit `done` rather than `stage`,
    // matching the wire format in docs/USER_FLOW.md.
    store.update(jobId, { stage: 'done' });
    emitter.emit({ event: 'done', data: { jobId } });
  } catch (err) {
    const code: ExtractErrorCode =
      err instanceof ExtractError ? err.code : 'INTERNAL_ERROR';
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
