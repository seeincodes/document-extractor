'use client';

import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';
import { FileSearch } from 'lucide-react';

import { ApiErrorBanner } from '@/components/api-error';
import { JobProgress } from '@/components/job-progress';
import { RegionCard } from '@/components/region-card';
import { UploadZone } from '@/components/upload-zone';

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
    setFile(chosen);
    setJobId(null);
    setRegions(INITIAL_REGIONS);
    setApiError(null);
    setUploading(true);

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
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-12">
      <header className="space-y-1">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-zinc-900 dark:bg-zinc-100">
            <FileSearch className="size-5 text-white dark:text-zinc-900" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
              Document Extractor
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Extract letterhead, footer, and signature regions automatically.
            </p>
          </div>
        </div>
      </header>

      <UploadZone onFile={handleFile} disabled={uploading} />

      {apiError ? <ApiErrorBanner error={apiError} /> : null}

      {file ? (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          <PdfPreview file={file} />
          {jobId ? (
            <JobProgress key={jobId} jobId={jobId} onEvent={handleSseEvent} />
          ) : (
            <div className="flex items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50/50 p-6 text-sm text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/30">
              {uploading ? 'Uploading\u2026' : 'Ready to process'}
            </div>
          )}
        </section>
      ) : null}

      {jobId ? (
        <>
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800" />
            <span className="text-xs font-medium text-zinc-400 dark:text-zinc-500">
              Extracted Regions
            </span>
            <div className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800" />
          </div>
          <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <RegionCard region="letterhead" state={regions.letterhead} />
            <RegionCard region="footer" state={regions.footer} />
            <RegionCard region="signature" state={regions.signature} />
          </section>
        </>
      ) : null}
    </main>
  );
}
