'use client';

import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';

import { ApiErrorBanner } from '@/components/api-error';
import { JobProgress } from '@/components/job-progress';
import { RegionCard } from '@/components/region-card';
import { UploadZone } from '@/components/upload-zone';

// react-pdf imports pdfjs-dist, which touches `DOMMatrix` at module load —
// that's a browser-only global. Loading it via next/dynamic with ssr: false
// keeps it out of the server bundle and the prerender pass.
const PdfPreview = dynamic(
  () => import('@/components/pdf-preview').then((m) => m.PdfPreview),
  { ssr: false },
);
import type {
  ApiError,
  ClientSseEvent,
  RegionName,
  RegionViewState,
} from '@/lib/ui/types';

type RegionMap = Record<RegionName, RegionViewState>;

const INITIAL_REGIONS: RegionMap = {
  letterhead: { status: 'pending' },
  footer: { status: 'pending' },
  signature: { status: 'pending' },
};

interface UploadResponse {
  jobId: string;
}

async function postUpload(file: File): Promise<
  | { ok: true; jobId: string }
  | { ok: false; error: ApiError }
> {
  const form = new FormData();
  form.append('file', file);

  let res: Response;
  try {
    res = await fetch('/api/extract', { method: 'POST', body: form });
  } catch {
    return {
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Network error.' },
    };
  }

  if (res.ok) {
    const body = (await res.json()) as UploadResponse;
    return { ok: true, jobId: body.jobId };
  }
  try {
    const body = (await res.json()) as ApiError;
    return { ok: false, error: body };
  } catch {
    return {
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: `HTTP ${res.status}` },
    };
  }
}

export function HomePage() {
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [regions, setRegions] = useState<RegionMap>(INITIAL_REGIONS);
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = useCallback(async (chosen: File) => {
    // Reset per-job state on a fresh file.
    setFile(chosen);
    setJobId(null);
    setRegions(INITIAL_REGIONS);
    setApiError(null);
    setUploading(true);

    // TODO: if the user picks a second file while file 1's POST is still in
    // flight (rare but possible — 200–500ms window), the first call's
    // setJobId still wins on resolve. Wire an AbortController per upload
    // and abort the previous fetch when a new file lands.
    const result = await postUpload(chosen);
    setUploading(false);
    if (result.ok) {
      setJobId(result.jobId);
    } else {
      setApiError(result.error);
    }
  }, []);

  const handleSseEvent = useCallback((event: ClientSseEvent) => {
    if (event.event === 'region_ready') {
      const { data } = event;
      setRegions((prev) => ({
        ...prev,
        [data.region]:
          data.status === 'not_found'
            ? { status: 'not_found', reason: data.reason }
            : {
                status: data.status,
                detector: data.detector,
                confidence: data.confidence,
                url: data.url,
              },
      }));
    } else if (event.event === 'error') {
      setApiError(event.data);
    }
    // stage + done don't need to mutate region state; JobProgress already
    // owns the visual rendering of stages.
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Document Extractor
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Upload a PDF, DOCX, or image. We&rsquo;ll pull out the letterhead, footer, and signature for
          you.
        </p>
      </header>

      <UploadZone onFile={handleFile} disabled={uploading} />

      {apiError ? <ApiErrorBanner error={apiError} /> : null}

      {file ? (
        <section className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <PdfPreview file={file} />
          {jobId ? (
            <JobProgress key={jobId} jobId={jobId} onEvent={handleSseEvent} />
          ) : (
            <div className="rounded-md border border-zinc-200 bg-zinc-50 p-6 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              {uploading ? 'Uploading…' : 'Waiting for upload to start.'}
            </div>
          )}
        </section>
      ) : null}

      {jobId ? (
        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <RegionCard region="letterhead" state={regions.letterhead} />
          <RegionCard region="footer" state={regions.footer} />
          <RegionCard region="signature" state={regions.signature} />
        </section>
      ) : null}
    </main>
  );
}
