import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateUpload, type ValidatedUpload } from './validate';

const FIXTURE_DIR = resolve(__dirname, '../../../tests/fixtures');
const CLEAN_LETTER = resolve(__dirname, '../../../samples/clean-letter.pdf');
const DOCX_FIXTURE = resolve(FIXTURE_DIR, 'minimal.docx');

const minimalPng = (): Uint8Array =>
  // Signature + zero-payload IHDR chunk (declared CRC omitted; file-type only
  // sniffs the signature + first chunk type, not the CRC).
  new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x00, 0x00, 0x00, 0x00,
  ]);

const minimalJpeg = (): Uint8Array =>
  // SOI + JFIF APP0 + EOI.
  new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xd9,
  ]);

const minimalTiff = (): Uint8Array =>
  // Little-endian TIFF header, IFD offset 8, then an empty IFD.
  new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0, 0, 0]);

const minimalWebp = (): Uint8Array =>
  // RIFF + size + WEBP + VP8L fourcc.
  new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
    0x38, 0x4c,
  ]);

describe('validateUpload', () => {
  it('accepts a PDF', async () => {
    const bytes = new Uint8Array(readFileSync(CLEAN_LETTER));
    const result = await validateUpload(bytes);
    expect(result).toEqual<ValidatedUpload>({
      kind: 'pdf',
      mime: 'application/pdf',
      ext: 'pdf',
      byteLength: bytes.byteLength,
    });
  });

  it.runIf(existsSync(DOCX_FIXTURE))('accepts a DOCX', async () => {
    const bytes = new Uint8Array(readFileSync(DOCX_FIXTURE));
    const result = await validateUpload(bytes);
    expect(result.kind).toBe('docx');
    expect(result.mime).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(result.ext).toBe('docx');
  });

  it('accepts a PNG', async () => {
    const result = await validateUpload(minimalPng());
    expect(result.kind).toBe('png');
    expect(result.mime).toBe('image/png');
  });

  it('accepts a JPEG', async () => {
    const result = await validateUpload(minimalJpeg());
    expect(result.kind).toBe('jpeg');
    expect(result.mime).toBe('image/jpeg');
  });

  it('accepts a TIFF (tier-2)', async () => {
    const result = await validateUpload(minimalTiff());
    expect(result.kind).toBe('tiff');
    expect(result.mime).toBe('image/tiff');
  });

  it('accepts a WEBP (tier-2)', async () => {
    const result = await validateUpload(minimalWebp());
    expect(result.kind).toBe('webp');
    expect(result.mime).toBe('image/webp');
  });

  it('rejects plain text with UNSUPPORTED_FILE_TYPE', async () => {
    const text = new TextEncoder().encode(
      'This is just a text file, not a document.\n',
    );
    await expect(validateUpload(text)).rejects.toMatchObject({
      name: 'ExtractError',
      code: 'UNSUPPORTED_FILE_TYPE',
    });
  });

  it('rejects an unsupported but detectable type (generic ZIP)', async () => {
    // Plain ZIP magic without an Office content-types entry — file-type
    // returns ext:'zip'. We do not accept generic ZIPs.
    const bareZip = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0,
    ]);
    await expect(validateUpload(bareZip)).rejects.toMatchObject({
      name: 'ExtractError',
      code: 'UNSUPPORTED_FILE_TYPE',
    });
  });

  it('rejects oversized input with FILE_TOO_LARGE', async () => {
    const bytes = new Uint8Array(readFileSync(CLEAN_LETTER));
    await expect(
      validateUpload(bytes, { maxBytes: 100 }),
    ).rejects.toMatchObject({
      name: 'ExtractError',
      code: 'FILE_TOO_LARGE',
    });
  });

  it('enforces the size cap before sniffing magic bytes', async () => {
    // A valid PNG that's larger than the cap should still surface as
    // FILE_TOO_LARGE, not UNSUPPORTED_FILE_TYPE. Order of checks matters.
    const bigPng = minimalPng();
    await expect(
      validateUpload(bigPng, { maxBytes: 5 }),
    ).rejects.toMatchObject({
      name: 'ExtractError',
      code: 'FILE_TOO_LARGE',
    });
  });
});
