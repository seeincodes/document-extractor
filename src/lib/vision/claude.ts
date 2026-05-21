import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';

import type { NormalizedBBox } from '../extract/jobStore';
import { logger } from '../logger';

import type { VisionBudget } from './budget';

const ESTIMATED_COST_PER_CALL = 0.003;

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

interface VerifyResult {
  verified: boolean;
  bbox: NormalizedBBox;
  confidence: number;
}

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (client) return client;
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return null;
  client = new Anthropic({ apiKey });
  return client;
}

export async function verifySignature(
  candidateImage: Buffer,
  currentBbox: NormalizedBBox,
  budget: VisionBudget,
): Promise<VerifyResult | null> {
  const anthropic = getClient();
  if (!anthropic) {
    logger.info('ANTHROPIC_API_KEY not set; vision fallback disabled');
    return null;
  }

  if (!budget.canAfford(ESTIMATED_COST_PER_CALL)) {
    logger.info('Vision budget exhausted; skipping verification');
    return null;
  }

  const model = process.env['VISION_MODEL'] ?? DEFAULT_MODEL;

  const png = await sharp(candidateImage).png().toBuffer();
  const base64 = png.toString('base64');

  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64,
              },
            },
            {
              type: 'text',
              text: `This image is a cropped region from the bottom of a document page. Determine if it contains a handwritten or electronic signature.

Respond with ONLY valid JSON (no markdown fencing) in this exact shape:
{
  "contains_signature": true/false,
  "confidence": 0.0-1.0,
  "bbox": { "x": 0.0-1.0, "y": 0.0-1.0, "w": 0.0-1.0, "h": 0.0-1.0 }
}

The bbox should be normalized coordinates (0-1) within this cropped image indicating the tightest bounding box around the signature. If no signature is found, return the original bbox with contains_signature=false.`,
            },
          ],
        },
      ],
    });

    budget.charge(ESTIMATED_COST_PER_CALL);

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return null;

    const parsed = JSON.parse(textBlock.text) as {
      contains_signature: boolean;
      confidence: number;
      bbox: NormalizedBBox;
    };

    return {
      verified: parsed.contains_signature,
      bbox: parsed.bbox,
      confidence: parsed.confidence,
    };
  } catch (err) {
    logger.error({ err }, 'Vision verification failed');
    return null;
  }
}

export function isVisionAvailable(): boolean {
  return Boolean(process.env['ANTHROPIC_API_KEY']);
}
