'use client';

import { AlertCircle } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

import type { ApiError as ApiErrorShape } from '@/lib/ui/types';

interface Props {
  error: ApiErrorShape;
  className?: string;
}

export function ApiErrorBanner({ error, className }: Readonly<Props>) {
  return (
    <Alert variant="destructive" className={cn(className)}>
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{titleForCode(error.code)}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}

// Short human-readable title for each error code. The full user-facing
// message comes from the API response body (toUserMessage on the server).
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
  }
}
