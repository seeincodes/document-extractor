import { describe, it, expect } from 'vitest';

import { toUserMessage, type ExtractErrorCode } from './errors';

const ALL_CODES: ExtractErrorCode[] = [
  'UNSUPPORTED_FILE_TYPE',
  'FILE_TOO_LARGE',
  'ENCRYPTED_PDF',
  'MALFORMED_PDF',
  'PAGE_LIMIT_EXCEEDED',
  'INTERNAL_ERROR',
  'REGION_NOT_DETECTED',
  'NOT_FOUND',
  'INVALID_JOB_ID',
  'UNSUPPORTED_REGION',
  'TIMEOUT',
  'SERVICE_BUSY',
  'CONVERSION_FAILED',
];

describe('toUserMessage covers all codes', () => {
  for (const code of ALL_CODES) {
    it(`returns a non-empty message for ${code}`, () => {
      const msg = toUserMessage(code);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    });
  }
});
