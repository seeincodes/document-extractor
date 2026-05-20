'use client';

import { AlertTriangle } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ApiError as ApiErrorShape } from '@/lib/ui/types';

interface Props {
  error: ApiErrorShape;
  className?: string;
}

export function ApiErrorBanner({ error, className }: Readonly<Props>) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border border-red-200 bg-red-50/80 px-4 py-3 dark:border-red-900/40 dark:bg-red-950/20',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500 dark:text-red-400" aria-hidden />
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-red-800 dark:text-red-300">
          {titleForCode(error.code)}
        </p>
        <p className="text-xs text-red-600 dark:text-red-400/80">
          {error.message}
        </p>
      </div>
    </div>
  );
}

function titleForCode(code: ApiErrorShape['code']): string {
  switch (code) {
    case 'UNSUPPORTED_FILE_TYPE':
      return 'Unsupported file type';
    case 'FILE_TOO_LARGE':
      return 'File too large';
    case 'ENCRYPTED_PDF':
      return 'Password-protected PDF';
    case 'MALFORMED_PDF':
      return "Can't parse PDF";
    case 'PAGE_LIMIT_EXCEEDED':
      return 'Too many pages';
    case 'REGION_NOT_DETECTED':
      return 'Region not detected';
    case 'INTERNAL_ERROR':
      return 'Something went wrong';
    case 'NOT_FOUND':
      return 'Not found';
    case 'INVALID_JOB_ID':
      return 'Invalid job ID';
    case 'UNSUPPORTED_REGION':
      return 'Unsupported region';
    case 'TIMEOUT':
      return 'Processing timed out';
    case 'SERVICE_BUSY':
      return 'Server busy';
    case 'CONVERSION_FAILED':
      return 'Conversion failed';
  }
}
