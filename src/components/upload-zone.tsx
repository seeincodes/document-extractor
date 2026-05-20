'use client';

// UploadZone — drag-and-drop + click-to-choose for a single document.
// The parent owns the "selected file" state; this component only fires
// `onFile` when react-dropzone confirms a single accepted file.

import { useCallback } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import type { UploadZoneProps } from '@/lib/ui/types';
import { cn } from '@/lib/utils';

// Mirrors the magic-byte allowlist enforced server-side (lib/io). The
// `accept` map is purely a UX hint — the server re-validates by bytes.
const ACCEPT = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/tiff': ['.tif', '.tiff'],
  'image/webp': ['.webp'],
} as const;

export function UploadZone({ onFile, disabled = false, className }: UploadZoneProps) {
  const onDrop = useCallback(
    (accepted: File[], rejections: FileRejection[]) => {
      // Reject multi-file drops outright; only fire when exactly one file
      // passed react-dropzone's accept/maxFiles gates.
      if (rejections.length > 0 || accepted.length !== 1) return;
      const file = accepted[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  const { getRootProps, getInputProps, isDragActive, isDragAccept, isDragReject } = useDropzone({
    onDrop,
    accept: ACCEPT,
    maxFiles: 1,
    multiple: false,
    disabled,
  });

  // Pick a label + border treatment based on the current drag state.
  // `isDragReject` wins over `isDragAccept` so a mixed/invalid drag shows
  // the red affordance.
  let label = 'Drop a PDF, DOCX, or image here, or click to choose';
  if (isDragReject) label = 'File type not supported.';
  else if (isDragAccept) label = 'Drop to upload.';

  return (
    <div
      {...getRootProps({
        'aria-label': 'Upload document',
        className: cn(
          'flex h-[250px] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 text-center transition-colors',
          // Idle palette — matches the zinc scaffold in app/page.tsx.
          'border-zinc-300 bg-white text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
          // Active (valid) drag — blue accent.
          isDragAccept && 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40',
          // Rejected drag — red accent. Also handles the case where
          // react-dropzone marks the drag as both active and rejected.
          isDragReject && 'border-red-500 bg-red-50 text-red-700 dark:bg-red-950/40',
          // Fallback "active but neither accept nor reject" — rare, but
          // keep some visual feedback so the user knows the zone sees them.
          isDragActive && !isDragAccept && !isDragReject && 'border-zinc-500',
          // Disabled: dim everything and block the cursor.
          disabled && 'cursor-not-allowed opacity-50 hover:border-zinc-300 dark:hover:border-zinc-700',
          className,
        ),
      })}
    >
      <input {...getInputProps()} />
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Supported: PDF, DOCX, PNG, JPEG (TIFF, WEBP)
      </p>
    </div>
  );
}
