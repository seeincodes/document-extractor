import { describe, it, expect } from 'vitest';

import { ExtractError, toUserMessage, type ExtractErrorCode } from './errors';

describe('ExtractError', () => {
  it('captures the code, name, message, and optional cause', () => {
    const underlying = new Error('underlying');
    const err = new ExtractError('ENCRYPTED_PDF', 'oops', { cause: underlying });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ExtractError');
    expect(err.code).toBe('ENCRYPTED_PDF');
    expect(err.message).toBe('oops');
    expect(err.cause).toBe(underlying);
  });

  it('is constructable without a cause', () => {
    const err = new ExtractError('FILE_TOO_LARGE', 'too big');
    expect(err.cause).toBeUndefined();
    expect(err.code).toBe('FILE_TOO_LARGE');
  });
});

describe('toUserMessage', () => {
  const expectations: Array<[ExtractErrorCode, string]> = [
    [
      'UNSUPPORTED_FILE_TYPE',
      "We don't support that file type. Supported: PDF, DOCX, PNG, JPEG.",
    ],
    ['FILE_TOO_LARGE', 'The file is too large. The limit is 25 MB.'],
    [
      'ENCRYPTED_PDF',
      "This PDF is password-protected. We don't support encrypted files.",
    ],
    ['MALFORMED_PDF', "This PDF couldn't be parsed. It may be corrupted."],
    ['PAGE_LIMIT_EXCEEDED', 'This document has too many pages. The limit is 50.'],
    ['INTERNAL_ERROR', 'Something went wrong on our end. Please try again.'],
  ];

  for (const [code, message] of expectations) {
    it(`maps ${code} → user-friendly message`, () => {
      expect(toUserMessage(code)).toBe(message);
    });
  }
});
