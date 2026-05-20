import { fileTypeFromBuffer } from 'file-type';

import { ExtractError } from '../extract/errors';

const DEFAULT_MAX_BYTES = 26_214_400; // 25 MB — docs/TECH_STACK.md MAX_UPLOAD_BYTES default.

export type SupportedKind = 'pdf' | 'docx' | 'png' | 'jpeg' | 'tiff' | 'webp';

export interface ValidatedUpload {
  kind: SupportedKind;
  mime: string;
  ext: SupportedKind;
  byteLength: number;
}

export interface ValidateOptions {
  maxBytes?: number;
}

// file-type's ext field uses 'jpg' and 'tif'; we normalize to 'jpeg' and 'tiff'
// so the SupportedKind union has one name per format.
const KIND_BY_MIME: Record<string, SupportedKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
};

export async function validateUpload(
  bytes: Uint8Array,
  opts: ValidateOptions = {},
): Promise<ValidatedUpload> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  // Size check first: a too-large file should never reach the magic-byte
  // sniff (which would buffer the whole thing).
  if (bytes.byteLength > maxBytes) {
    throw new ExtractError(
      'FILE_TOO_LARGE',
      `Upload is ${bytes.byteLength} bytes; the limit is ${maxBytes}.`,
    );
  }

  const detected = await fileTypeFromBuffer(bytes);
  const kind = detected ? KIND_BY_MIME[detected.mime] : undefined;
  if (!detected || !kind) {
    throw new ExtractError(
      'UNSUPPORTED_FILE_TYPE',
      'File type is not one of: PDF, DOCX, PNG, JPEG, TIFF, WEBP.',
    );
  }

  return {
    kind,
    mime: detected.mime,
    ext: kind,
    byteLength: bytes.byteLength,
  };
}
