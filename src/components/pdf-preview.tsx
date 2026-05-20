'use client';

import { useEffect, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { PdfPreviewProps } from '@/lib/ui/types';

// Configure the pdf.js worker in the same module that renders <Document>, per
// the react-pdf README's WARNING. Using `new URL(..., import.meta.url)` lets
// Next.js's bundler emit a co-located worker asset, so we don't depend on the
// unpkg CDN at runtime.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

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
    <Card className={cn('w-full max-w-md', className)}>
      <CardHeader>
        <CardTitle>Preview</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="max-h-[600px] overflow-y-auto rounded-md ring-1 ring-zinc-200/60">
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[560px] items-center justify-center px-6 text-center text-sm text-zinc-500">
      {children}
    </div>
  );
}

export function PdfPreview({ file, className }: PdfPreviewProps) {
  // The synchronous branches (no file, wrong type, loading) are all derived
  // from `file` plus the keyed async result in render. The effect only
  // writes to state from inside the promise callbacks — never synchronously
  // — which satisfies react-hooks/set-state-in-effect.
  const isPdf = file !== null && file.type.startsWith('application/pdf');
  const [asyncResult, setAsyncResult] = useState<
    | { fileKey: File | null; data: ArrayBuffer }
    | { fileKey: File | null; error: true }
    | null
  >(null);
  const [numPages, setNumPages] = useState(0);

  useEffect(() => {
    if (!isPdf || file === null) return;

    let cancelled = false;
    const fileKey = file;

    file
      .arrayBuffer()
      .then((buf) => {
        if (!cancelled) {
          setAsyncResult({ fileKey, data: buf });
          setNumPages(0);
        }
      })
      .catch(() => {
        if (!cancelled) setAsyncResult({ fileKey, error: true });
      });

    return () => {
      cancelled = true;
    };
  }, [file, isPdf]);

  // Derive the render state from props + async result. If the async result
  // is for a stale file (user picked a new one before the previous load
  // finished), treat it as still loading.
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
        <Placeholder>Preview will appear here once you upload a file.</Placeholder>
      </PreviewShell>
    );
  }
  if (state.kind === 'unsupported') {
    return (
      <PreviewShell className={className}>
        <Placeholder>Preview unavailable for this file type.</Placeholder>
      </PreviewShell>
    );
  }
  if (state.kind === 'loading') {
    return (
      <PreviewShell className={className}>
        <Placeholder>Loading preview…</Placeholder>
      </PreviewShell>
    );
  }
  if (state.kind === 'error') {
    return (
      <PreviewShell className={className}>
        <Placeholder>Couldn&rsquo;t render the preview.</Placeholder>
      </PreviewShell>
    );
  }

  return (
    <PreviewShell className={className}>
      <Document
        file={{ data: state.data }}
        onLoadSuccess={({ numPages: n }) => setNumPages(n)}
        onLoadError={() => {
          if (file) setAsyncResult({ fileKey: file, error: true });
        }}
        loading={<Placeholder>Loading preview…</Placeholder>}
        error={<Placeholder>Couldn&rsquo;t render the preview.</Placeholder>}
        className="flex flex-col gap-2 p-2"
      >
        {Array.from({ length: numPages }, (_, i) => (
          <Page
            key={i + 1}
            pageNumber={i + 1}
            width={380}
            renderAnnotationLayer={false}
            renderTextLayer={false}
            className="overflow-hidden rounded-sm ring-1 ring-zinc-200/70"
          />
        ))}
      </Document>
    </PreviewShell>
  );
}
