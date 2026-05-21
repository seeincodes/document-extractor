import { execFile } from 'node:child_process';
import { freemem } from 'node:os';
import { promisify } from 'node:util';

import { heavyQueue } from '@/lib/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

const startedAt = Date.now();

interface ProbeResult {
  available: boolean;
  version?: string;
}

let libreofficeProbe: ProbeResult | null = null;
let tesseractProbe: ProbeResult | null = null;

async function probeLibreoffice(): Promise<ProbeResult> {
  if (libreofficeProbe) return libreofficeProbe;
  try {
    const { stdout } = await execFileAsync('soffice', ['--version'], {
      timeout: 5_000,
    });
    libreofficeProbe = { available: true, version: stdout.trim() };
  } catch {
    libreofficeProbe = { available: false };
  }
  return libreofficeProbe;
}

async function probeTesseract(): Promise<ProbeResult> {
  if (tesseractProbe) return tesseractProbe;
  try {
    const { stdout } = await execFileAsync('tesseract', ['--version'], {
      timeout: 5_000,
    });
    const firstLine = stdout.split('\n')[0] ?? '';
    tesseractProbe = { available: true, version: firstLine.trim() };
  } catch {
    tesseractProbe = { available: false };
  }
  return tesseractProbe;
}

export async function GET(): Promise<Response> {
  const [lo, tess] = await Promise.all([
    probeLibreoffice(),
    probeTesseract(),
  ]);

  const body = {
    status: 'ok',
    libreoffice: lo,
    tesseract: tess,
    freeDiskMB: Math.round(freemem() / 1_048_576),
    queueDepth: heavyQueue.size + heavyQueue.pending,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1_000),
  };

  return Response.json(body, { status: 200 });
}
