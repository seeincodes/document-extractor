'use client';

import { AlertCircle, CheckCircle2, Download, Eye, Loader2, Search } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import type { RegionCardProps, RegionName } from '@/lib/ui/types';
import { cn } from '@/lib/utils';

const REGION_LABELS: Record<RegionName, { title: string; downloadAria: string }> = {
  letterhead: { title: 'Letterhead', downloadAria: 'Download letterhead PNG' },
  footer: { title: 'Footer', downloadAria: 'Download footer PNG' },
  signature: { title: 'Signature', downloadAria: 'Download signature PNG' },
};

const REGION_ICONS: Record<RegionName, string> = {
  letterhead: '📄',
  footer: '📋',
  signature: '✍️',
};

export function RegionCard({ region, state }: RegionCardProps) {
  const { title, downloadAria } = REGION_LABELS[region];

  return (
    <div className="group flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <span className="text-base" aria-hidden>{REGION_ICONS[region]}</span>
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{title}</h3>
        {state.status === 'pending' && (
          <Loader2 className="ml-auto size-3.5 animate-spin text-zinc-300" aria-hidden />
        )}
        {(state.status === 'detected' || state.status === 'unverified') && (
          <CheckCircle2
            className={cn(
              'ml-auto size-3.5',
              state.status === 'unverified'
                ? 'text-amber-500'
                : 'text-emerald-500',
            )}
            aria-hidden
          />
        )}
        {state.status === 'not_found' && (
          <AlertCircle className="ml-auto size-3.5 text-zinc-300" aria-hidden />
        )}
      </div>

      <div className="flex flex-1 flex-col">
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
      </div>
    </div>
  );
}

function PendingBody() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-zinc-300 dark:text-zinc-700">
      <Search className="size-8" aria-hidden />
      <span className="text-xs font-medium text-zinc-400 dark:text-zinc-500">Analyzing&hellip;</span>
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
      <div className="relative bg-zinc-50 p-3 dark:bg-zinc-900/60">
        <div className="flex items-center justify-center overflow-hidden rounded-lg bg-white ring-1 ring-zinc-200/60 dark:bg-zinc-950 dark:ring-zinc-800">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={`${region} crop`}
            className="max-h-[180px] w-full object-contain p-2"
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
              unverified
                ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/60 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800/40'
                : 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800/40',
            )}
          >
            {unverified && <AlertCircle className="size-2.5" aria-hidden />}
            {pct}%
          </span>
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
            {detector === 'vision' ? 'vision' : 'heuristic'}
          </span>
        </div>
        <a
          href={url}
          download={`${region}.png`}
          aria-label={downloadAria}
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'sm' }),
            'h-7 gap-1 px-2 text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
          )}
        >
          <Download className="size-3" aria-hidden />
          Save
        </a>
      </div>
    </>
  );
}

function NotFoundBody({ reason }: { reason: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <Eye className="size-6 text-zinc-200 dark:text-zinc-700" aria-hidden />
      <p className="max-w-[180px] text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">
        {reason}
      </p>
    </div>
  );
}
