export type ExtractErrorCode =
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'ENCRYPTED_PDF'
  | 'MALFORMED_PDF'
  | 'PAGE_LIMIT_EXCEEDED'
  | 'INTERNAL_ERROR'
  | 'REGION_NOT_DETECTED'
  | 'NOT_FOUND'
  | 'INVALID_JOB_ID'
  | 'UNSUPPORTED_REGION';

export class ExtractError extends Error {
  override name = 'ExtractError' as const;
  constructor(
    readonly code: ExtractErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const USER_MESSAGES: Record<ExtractErrorCode, string> = {
  UNSUPPORTED_FILE_TYPE:
    "We don't support that file type. Supported: PDF, DOCX, PNG, JPEG.",
  FILE_TOO_LARGE: 'The file is too large. The limit is 25 MB.',
  ENCRYPTED_PDF:
    "This PDF is password-protected. We don't support encrypted files.",
  MALFORMED_PDF: "This PDF couldn't be parsed. It may be corrupted.",
  PAGE_LIMIT_EXCEEDED: 'This document has too many pages. The limit is 50.',
  INTERNAL_ERROR: 'Something went wrong on our end. Please try again.',
  REGION_NOT_DETECTED:
    'This region could not be detected on the document.',
  NOT_FOUND: 'The requested job or region could not be found.',
  INVALID_JOB_ID: 'The job ID has an invalid format.',
  UNSUPPORTED_REGION: 'The requested region is not one we extract.',
};

export function toUserMessage(code: ExtractErrorCode): string {
  return USER_MESSAGES[code];
}
