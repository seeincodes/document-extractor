'use client';

import { useEffect, useMemo, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { FileText, ImageIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { PdfPreviewProps } from '@/lib/ui/types';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

type LoadState =
  | { kind: 'empty' }
  | { kind: 'unsupported' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: ArrayBuffer }
  | { kind: 'error' };

function PreviewShell({
  className,
  children,
}: {
  className?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900', className)}>
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <FileText className="size-4 text-zinc-400" aria-hidden />
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Preview</h3>
      </div>
      <div className="max-h-[600px] overflow-y-auto bg-zinc-50/50 dark:bg-zinc-950/30">
        {children}
      </div>
    </div>
  );
}

function Placeholder({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex h-[400px] flex-col items-center justify-center gap-3 px-6 text-center">
      {icon ?? <ImageIcon className="size-8 text-zinc-200 dark:text-zinc-700" aria-hidden />}
      <p className="max-w-[200px] text-sm text-zinc-400 dark:text-zinc-500">{children}</p>
    </div>
  );
}

export function PdfPreview({ file, className }: PdfPreviewProps) {
  const isPdf = file !== null && file.type.startsWith('application/pdf');
  const [asyncResult, setAsyncResult] = useState<
    | { fileKey: File; data: ArrayBuffer }
    | { fileKey: File; error: true }
    | null
  >(null);
  const [pdfMeta, setPdfMeta] = useState<
    { fileKey: File; numPages: number } | null
  >(null);

  useEffect(() => {
    if (!isPdf || file === null) return;

    let cancelled = false;
    const fileKey = file;

    file
      .arrayBuffer()
      .then((buf) => {
        if (!cancelled) setAsyncResult({ fileKey, data: buf });
      })
      .catch(() => {
        if (!cancelled) setAsyncResult({ fileKey, error: true });
      });

    return () => {
      cancelled = true;
    };
  }, [file, isPdf]);

  const readyData =
    asyncResult !== null && !('error' in asyncResult)
      ? asyncResult.data
      : null;
  const fileData = useMemo(
    () => (readyData !== null ? { data: readyData } : null),
    [readyData],
  );

  const state: LoadState = ((): LoadState => {
    if (file === null) return { kind: 'empty' };
    if (!isPdf) return { kind: 'unsupported' };
    if (asyncResult === null || asyncResult.fileKey !== file) {
      return { kind: 'loading' };
    }
    if ('error' in asyncResult) return { kind: 'error' };
    return { kind: 'ready', data: asyncResult.data };
  })();

  if (state.kind === 'empty') {
    return (
      <PreviewShell className={className}>
        <Placeholder>Upload a document to see a preview here.</Placeholder>
      </PreviewShell>
    );
  }
  if (state.kind === 'unsupported') {
    return (
      <PreviewShell className={className}>
        <Placeholder>Preview is not available for this file type.</Placeholder>
      </PreviewShell>
    );
  }
  if (state.kind === 'loading') {
    return (
      <PreviewShell className={className}>
        <Placeholder>Loading preview&hellip;</Placeholder>
      </PreviewShell>
    );
  }
  if (state.kind === 'error') {
    return (
      <PreviewShell className={className}>
        <Placeholder>Could not render preview.</Placeholder>
      </PreviewShell>
    );
  }

  const numPages = pdfMeta && pdfMeta.fileKey === file ? pdfMeta.numPages : 0;

  return (
    <PreviewShell className={className}>
      <Document
        file={fileData ?? { data: state.data }}
        onLoadSuccess={({ numPages: n }) => {
          if (file) setPdfMeta({ fileKey: file, numPages: n });
        }}
        onLoadError={() => {
          if (file) setAsyncResult({ fileKey: file, error: true });
        }}
        loading={<Placeholder>Loading preview&hellip;</Placeholder>}
        error={<Placeholder>Could not render preview.</Placeholder>}
        className="flex flex-col gap-3 p-3"
      >
        {Array.from({ length: numPages }, (_, i) => (
          <Page
            key={i + 1}
            pageNumber={i + 1}
            width={380}
            renderAnnotationLayer={false}
            renderTextLayer={false}
            className="overflow-hidden rounded-lg shadow-sm ring-1 ring-zinc-200/60 dark:ring-zinc-800"
          />
        ))}
      </Document>
      {numPages > 0 && (
        <div className="border-t border-zinc-100 px-4 py-2 text-center text-[11px] text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
          {numPages} {numPages === 1 ? 'page' : 'pages'}
        </div>
      )}
    </PreviewShell>
  );
}
