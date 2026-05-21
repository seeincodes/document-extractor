'use client';

import { useCallback } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import { Upload, FileText, ImageIcon, AlertTriangle } from 'lucide-react';
import type { UploadZoneProps } from '@/lib/ui/types';
import { cn } from '@/lib/utils';

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

  return (
    <div
      {...getRootProps({
        'aria-label': 'Upload document',
        className: cn(
          'group relative flex w-full cursor-pointer flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed px-8 py-12 text-center transition-all duration-200',
          'border-zinc-200 bg-zinc-50/50 hover:border-primary/40 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/30 dark:hover:border-zinc-600 dark:hover:bg-zinc-900/50',
          isDragAccept && 'border-emerald-400 bg-emerald-50/60 dark:border-emerald-600 dark:bg-emerald-950/20',
          isDragReject && 'border-red-400 bg-red-50/60 dark:border-red-600 dark:bg-red-950/20',
          isDragActive && !isDragAccept && !isDragReject && 'border-zinc-400 bg-zinc-100/80 dark:border-zinc-600',
          disabled && 'cursor-not-allowed opacity-50',
          className,
        ),
      })}
    >
      <input {...getInputProps()} />

      <div
        className={cn(
          'flex size-14 items-center justify-center rounded-full transition-colors duration-200',
          isDragReject
            ? 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400'
            : isDragAccept
              ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-400'
              : 'bg-zinc-100 text-zinc-400 group-hover:bg-primary/10 group-hover:text-primary dark:bg-zinc-800 dark:text-zinc-500',
        )}
      >
        {isDragReject ? (
          <AlertTriangle className="size-6" />
        ) : (
          <Upload className="size-6" />
        )}
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
          {isDragReject
            ? 'File type not supported'
            : isDragAccept
              ? 'Drop to upload'
              : 'Drop a document here, or click to browse'}
        </p>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Supports PDF, DOCX, PNG, JPEG, TIFF, and WEBP
        </p>
      </div>

      <div className="flex items-center gap-3 text-zinc-300 dark:text-zinc-700">
        <div className="flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">
          <FileText className="size-3 text-zinc-400 dark:text-zinc-500" />
          <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">PDF</span>
        </div>
        <div className="flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">
          <FileText className="size-3 text-zinc-400 dark:text-zinc-500" />
          <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">DOCX</span>
        </div>
        <div className="flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">
          <ImageIcon className="size-3 text-zinc-400 dark:text-zinc-500" />
          <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">Image</span>
        </div>
      </div>
    </div>
  );
}
