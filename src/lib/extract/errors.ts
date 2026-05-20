export type ExtractErrorCode =
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'ENCRYPTED_PDF'
  | 'MALFORMED_PDF'
  | 'PAGE_LIMIT_EXCEEDED';

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
};

export function toUserMessage(code: ExtractErrorCode): string {
  return USER_MESSAGES[code];
}
