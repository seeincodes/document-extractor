'use client';

import { useEffect, useRef, useState } from 'react';
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

  // Stash onEvent in a ref so the SSE effect doesn't need to depend on it.
  // Without this, any future parent that wraps onEvent in a closure with
  // captured state would re-trigger the SSE effect, close the EventSource,
  // and reopen it — silently dropping in-flight events. The ref is updated
  // inside its own effect (not during render) per react-hooks/refs.
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  // Use fetch + ReadableStream instead of EventSource to consume the SSE
  // stream. EventSource has built-in reconnection that fires spurious 404
  // errors when the server closes the finished stream (and React StrictMode's
  // double-mount in dev makes it worse). A plain fetch gives full control.
  useEffect(() => {
    const ac = new AbortController();

    void (async () => {
      let res: Response;
      try {
        res = await fetch(`/api/extract/${jobId}/stream`, {
          signal: ac.signal,
        });
      } catch {
        // Aborted by cleanup — expected in StrictMode's double-mount.
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

          // Drain complete SSE frames (separated by blank lines).
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
        // AbortError from cleanup — silently stop.
      }
    })();

    return () => {
      ac.abort();
    };
  }, [jobId]);

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
