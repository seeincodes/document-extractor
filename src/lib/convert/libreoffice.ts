import { execFile } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import { ExtractError } from '../extract/errors';
import { logger } from '../logger';
import { heavyQueue } from '../queue';

const execFileAsync = promisify(execFile);

export async function docxToPdf(
  buffer: Uint8Array,
  tempDir: string,
): Promise<Uint8Array> {
  return heavyQueue.add(async () => {
    const inputPath = join(tempDir, 'input.docx');
    const { writeFile: fsWriteFile } = await import('node:fs/promises');
    await fsWriteFile(inputPath, buffer);

    const userInstall = join(
      tmpdir(),
      `lo-profile-${randomBytes(8).toString('hex')}`,
    );
    await mkdir(userInstall, { recursive: true });

    try {
      await execFileAsync(
        'soffice',
        [
          '--headless',
          '--convert-to',
          'pdf',
          '--norestore',
          '--nolockcheck',
          '--nodefault',
          '--nofirststartwizard',
          `-env:UserInstallation=file:///${userInstall}`,
          '--outdir',
          tempDir,
          inputPath,
        ],
        { timeout: 30_000 },
      );
    } catch (err) {
      logger.error({ err }, 'LibreOffice conversion failed');
      throw new ExtractError(
        'CONVERSION_FAILED',
        'LibreOffice DOCX→PDF conversion failed.',
        { cause: err },
      );
    }

    const pdfPath = join(tempDir, 'input.pdf');
    try {
      return new Uint8Array(await readFile(pdfPath));
    } catch {
      throw new ExtractError(
        'CONVERSION_FAILED',
        'LibreOffice did not produce a PDF output.',
      );
    }
  }) as Promise<Uint8Array>;
}
