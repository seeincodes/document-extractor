// Shared types for the client-side UI components. Defined once on the
// server so the four region-card / upload-zone / pdf-preview / job-
// progress components stay in lockstep with the API contract.

import type { ExtractErrorCode } from '../extract/errors';
import type { JobStage } from '../extract/jobStore';
import type { RegionName } from '../extract/sse';

export type { ExtractErrorCode, JobStage, RegionName };

// SSE event shapes as the *client* sees them. These mirror the server-side
// SseEvent union but are duplicated here so client modules don't reach into
// lib/extract/* (which pulls Node-only code). The runtime JSON shape on the
// wire is identical.
export type ClientSseEvent =
  | { event: 'stage'; data: { stage: JobStage; progress: number } }
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
        | { region: RegionName; status: 'not_found'; reason: string };
    }
  | { event: 'done'; data: { jobId: string } }
  | { event: 'error'; data: { code: ExtractErrorCode; message: string } };

// What the UI knows about one region at any point in time. The discriminant
// is `status`. The page-level state machine starts every region as
// 'pending' and transitions to detected | not_found via SSE events.
export type RegionViewState =
  | { status: 'pending' }
  | {
      status: 'detected' | 'unverified';
      detector: 'heuristic' | 'vision';
      confidence: number;
      url: string;
    }
  | { status: 'not_found'; reason: string };

// Errors surfaced by the API. The shape matches the JSON body the routes
// emit on a 4xx/5xx response.
export interface ApiError {
  code: ExtractErrorCode;
  message: string;
}

// ─── Component prop types ──────────────────────────────────────────────

export interface UploadZoneProps {
  // Called when the user picks (or drops) exactly one valid file.
  onFile: (file: File) => void;
  // True while a previous upload is in flight; the zone should look disabled.
  disabled?: boolean;
  // Optional class name for the parent to influence layout.
  className?: string;
}

export interface PdfPreviewProps {
  // The raw bytes of the PDF to preview. null means "no file yet."
  file: File | null;
  className?: string;
}

export interface JobProgressProps {
  // The jobId to subscribe to via SSE.
  jobId: string;
  // Fired on each SSE event so the parent can lift state.
  onEvent: (event: ClientSseEvent) => void;
}

export interface RegionCardProps {
  region: RegionName;
  state: RegionViewState;
  // The jobId is used to compose download URLs; the card is otherwise
  // stateless.
  jobId: string;
}
