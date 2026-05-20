'use client';

import { useEffect, useState } from 'react';
import { Check, Circle, Loader2 } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
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

  // The component expects the parent to remount it via `key={jobId}` when
  // the job changes — that's the idiomatic React 19 way to reset all the
  // useState defaults rather than calling setters synchronously in an
  // effect (which violates react-hooks/set-state-in-effect).
  useEffect(() => {
    const es = new EventSource(`/api/extract/${jobId}/stream`);

    const safeParse = <T,>(raw: string): T | null => {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    };

    const onStage = (e: MessageEvent) => {
      const data = safeParse<{ stage: JobStage; progress: number }>(e.data);
      if (!data) return;
      setStage(data.stage);
      setProgress(Math.max(0, Math.min(1, data.progress)));
      onEvent({ event: 'stage', data });
    };

    const onRegion = (e: MessageEvent) => {
      const data = safeParse<RegionReadyData>(e.data);
      if (!data) return;
      onEvent({ event: 'region_ready', data });
    };

    const onDone = (e: MessageEvent) => {
      const data = safeParse<{ jobId: string }>(e.data);
      if (!data) return;
      setProgress(1);
      setStage('done');
      setDoneMsg(true);
      setTerminated(true);
      onEvent({ event: 'done', data });
      es.close();
    };

    const onError = (e: MessageEvent) => {
      const data = safeParse<ErrorData>(e.data);
      if (!data) return;
      setErrorMsg(data.message);
      setStage('failed');
      setTerminated(true);
      onEvent({ event: 'error', data });
      es.close();
    };

    es.addEventListener('stage', onStage as EventListener);
    es.addEventListener('region_ready', onRegion as EventListener);
    es.addEventListener('done', onDone as EventListener);
    es.addEventListener('error', onError as EventListener);

    return () => {
      es.close();
    };
  }, [jobId, onEvent]);

  const pct = Math.round(progress * 100);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Progress</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Progress value={pct} />
        <ul className="flex flex-col gap-2">
          {STEPS.map((step) => {
            const s: Status = terminated && !errorMsg
              ? 'done'
              : stepStatus(step.stage, stage, progress);
            return (
              <li key={step.stage} className="flex items-center gap-2 text-sm text-zinc-700">
                {s === 'done' && <Check className="size-4 text-emerald-600" aria-hidden />}
                {s === 'current' && (
                  <Loader2 className="size-4 animate-spin text-zinc-600" aria-hidden />
                )}
                {s === 'pending' && <Circle className="size-4 text-zinc-300" aria-hidden />}
                <span className={s === 'pending' ? 'text-zinc-400' : undefined}>{step.label}</span>
              </li>
            );
          })}
        </ul>
        {errorMsg && (
          <Alert variant="destructive">
            <AlertTitle>Extraction failed</AlertTitle>
            <AlertDescription>{errorMsg}</AlertDescription>
          </Alert>
        )}
        {doneMsg && !errorMsg && (
          <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
            <AlertTitle>Extraction complete</AlertTitle>
            <AlertDescription className="text-emerald-800">
              All regions have been processed.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
