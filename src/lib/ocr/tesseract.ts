import { execFile } from 'node:child_process';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import sharp from 'sharp';

import { logger } from '../logger';
import { heavyQueue } from '../queue';

const execFileAsync = promisify(execFile);

export interface OcrResult {
  text: string;
  confidence: number;
}

export async function ocrPage(imageBuffer: Uint8Array): Promise<OcrResult> {
  return heavyQueue.add(async () => {
    const id = randomBytes(8).toString('hex');
    const inputPath = join(tmpdir(), `ocr-input-${id}.png`);
    const outputBase = join(tmpdir(), `ocr-output-${id}`);
    const outputPath = `${outputBase}.txt`;

    try {
      const png = await sharp(Buffer.from(imageBuffer))
        .png()
        .toBuffer();
      await writeFile(inputPath, png);

      const { stdout } = await execFileAsync(
        'tesseract',
        [inputPath, outputBase, '--oem', '3', '--psm', '6'],
        { timeout: 15_000 },
      );

      let confidence = 0;
      const confMatch = stdout.match(/confidence:\s*([\d.]+)/i);
      if (confMatch?.[1]) {
        confidence = Number(confMatch[1]) / 100;
      }

      const text = await readFile(outputPath, 'utf-8');
      return { text: text.trim(), confidence };
    } catch (err) {
      logger.warn({ err }, 'Tesseract OCR failed');
      return { text: '', confidence: 0 };
    } finally {
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
    }
  }) as Promise<OcrResult>;
}
