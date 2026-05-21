'use client';

import { AlertCircle, Download, Loader2 } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { RegionCardProps, RegionName } from '@/lib/ui/types';
import { cn } from '@/lib/utils';

// Capitalized titles and download-button aria-labels for each region. Kept
// here so the markup stays declarative.
const REGION_LABELS: Record<RegionName, { title: string; downloadAria: string }> = {
  letterhead: { title: 'Letterhead', downloadAria: 'Download letterhead PNG' },
  footer: { title: 'Footer', downloadAria: 'Download footer PNG' },
  signature: { title: 'Signature', downloadAria: 'Download signature PNG' },
};

export function RegionCard({ region, state }: RegionCardProps) {
  const { title, downloadAria } = REGION_LABELS[region];

  return (
    <Card className="flex h-full min-h-[280px] w-full flex-col">
      <CardHeader>
        <CardTitle className="text-zinc-800 dark:text-zinc-100">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {state.status === 'pending' && <PendingBody />}
        {(state.status === 'detected' || state.status === 'unverified') && (
          <DetectedBody
            region={region}
            url={state.url}
            detector={state.detector}
            confidence={state.confidence}
            unverified={state.status === 'unverified'}
            downloadAria={downloadAria}
          />
        )}
        {state.status === 'not_found' && <NotFoundBody reason={state.reason} />}
      </CardContent>
    </Card>
  );
}

function PendingBody() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-zinc-200 bg-zinc-50/50 py-10 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/30">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span className="text-xs">Waiting…</span>
    </div>
  );
}

interface DetectedBodyProps {
  region: RegionName;
  url: string;
  detector: 'heuristic' | 'vision';
  confidence: number;
  unverified: boolean;
  downloadAria: string;
}

function DetectedBody({
  region,
  url,
  detector,
  confidence,
  unverified,
  downloadAria,
}: DetectedBodyProps) {
  const pct = Math.round(confidence * 100);
  return (
    <>
      <div className="flex items-center justify-center overflow-hidden rounded-md bg-zinc-50 dark:bg-zinc-900/40">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={`${region} crop`}
          className="max-h-[200px] w-full object-contain"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs',
            unverified
              ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200'
              : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
          )}
        >
          {unverified && <AlertCircle className="size-3" aria-hidden />}
          {detector === 'vision' ? 'vision-verified' : detector} · {pct}%
        </span>
        {/* shadcn Button wraps Base UI <button>; for a native browser download
            we render an <a download> styled with buttonVariants. */}
        <a
          href={url}
          download={`${region}.png`}
          aria-label={downloadAria}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
        >
          <Download className="size-3.5" aria-hidden />
          Download
        </a>
      </div>
    </>
  );
}

function NotFoundBody({ reason }: { reason: string }) {
  return (
    <div className="flex flex-1 items-start gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{reason}</span>
    </div>
  );
}
