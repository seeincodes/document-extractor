'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';

import type { ClientSseEvent, JobProgressProps, JobStage } from '@/lib/ui/types';

type RegionReadyData = Extract<ClientSseEvent, { event: 'region_ready' }>['data'];
type ErrorData = Extract<ClientSseEvent, { event: 'error' }>['data'];

type Status = 'pending' | 'current' | 'done';

const STEPS: ReadonlyArray<{ label: string; stage: JobStage }> = [
  { label: 'Validating', stage: 'validating' },
  { label: 'Rasterizing', stage: 'rasterizing' },
  { label: 'Detecting letterhead', stage: 'detecting_letterhead' },
  { label: 'Detecting footer', stage: 'detecting_footer' },
  { label: 'Detecting signature', stage: 'detecting_signature' },
];

const ORDER: Record<JobStage, number> = {
  queued: 0,
  validating: 1,
  normalizing: 2,
  rasterizing: 3,
  detecting_letterhead: 4,
  detecting_footer: 5,
  detecting_signature: 6,
  done: 7,
  failed: 7,
};

function stepStatus(stepStage: JobStage, current: JobStage, progress: number): Status {
  const cur = ORDER[current];
  const step = ORDER[stepStage];
  if (cur > step) return 'done';
  if (cur < step) return 'pending';
  return progress >= 1 ? 'done' : 'current';
}

export function JobProgress({ jobId, onEvent }: JobProgressProps) {
  const [stage, setStage] = useState<JobStage>('queued');
  const [progress, setProgress] = useState(0);
  const [terminated, setTerminated] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState(false);

  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    const ac = new AbortController();

    void (async () => {
      let res: Response;
      try {
        res = await fetch(`/api/extract/${jobId}/stream`, {
          signal: ac.signal,
        });
      } catch {
        return;
      }
      if (!res.ok || !res.body) {
        setErrorMsg('Failed to connect to extraction stream.');
        setStage('failed');
        setTerminated(true);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const dispatch = (event: string, raw: string): void => {
        let data: unknown;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }

        if (event === 'stage') {
          const d = data as { stage: JobStage; progress: number };
          setStage(d.stage);
          setProgress(Math.max(0, Math.min(1, d.progress)));
          onEventRef.current({ event: 'stage', data: d });
        } else if (event === 'region_ready') {
          onEventRef.current({
            event: 'region_ready',
            data: data as RegionReadyData,
          });
        } else if (event === 'done') {
          setProgress(1);
          setStage('done');
          setDoneMsg(true);
          setTerminated(true);
          onEventRef.current({
            event: 'done',
            data: data as { jobId: string },
          });
        } else if (event === 'error') {
          const d = data as ErrorData;
          setErrorMsg(d.message);
          setStage('failed');
          setTerminated(true);
          onEventRef.current({ event: 'error', data: d });
        }
      };

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sep = buffer.indexOf('\n\n');
          while (sep !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let ev = '';
            let dat = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) ev = line.slice(6).trimStart();
              else if (line.startsWith('data:')) dat = line.slice(5).trimStart();
            }
            if (ev && dat) dispatch(ev, dat);
            sep = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // AbortError from cleanup
      }
    })();

    return () => {
      ac.abort();
    };
  }, [jobId]);

  const pct = Math.round(progress * 100);
  const completedCount = STEPS.filter((step) => {
    const s: Status = terminated && !errorMsg
      ? 'done'
      : stepStatus(step.stage, stage, progress);
    return s === 'done';
  }).length;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
          Progress
        </h3>
        <span className="text-xs font-medium text-zinc-400 dark:text-zinc-500">
          {completedCount}/{STEPS.length}
        </span>
      </div>

      <div className="px-4 pt-4 pb-1">
        <div className="relative h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-emerald-500 transition-all duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-0.5 px-2 py-3">
        {STEPS.map((step) => {
          const s: Status = terminated && !errorMsg
            ? 'done'
            : stepStatus(step.stage, stage, progress);
          return (
            <div
              key={step.stage}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors"
            >
              <div className="flex size-5 items-center justify-center">
                {s === 'done' && <Check className="size-4 text-emerald-500" aria-hidden />}
                {s === 'current' && (
                  <Loader2 className="size-4 animate-spin text-zinc-500" aria-hidden />
                )}
                {s === 'pending' && <Circle className="size-3.5 text-zinc-200 dark:text-zinc-700" aria-hidden />}
              </div>
              <span
                className={
                  s === 'done'
                    ? 'text-sm text-zinc-700 dark:text-zinc-300'
                    : s === 'current'
                      ? 'text-sm font-medium text-zinc-800 dark:text-zinc-100'
                      : 'text-sm text-zinc-300 dark:text-zinc-600'
                }
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>

      {errorMsg && (
        <div className="mx-3 mb-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">
          <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{errorMsg}</span>
        </div>
      )}
      {doneMsg && !errorMsg && (
        <div className="mx-3 mb-3 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
          <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
          All regions processed
        </div>
      )}
    </div>
  );
}
