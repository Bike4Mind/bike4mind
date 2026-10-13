import { usdToCredits } from '@bike4mind/utils';
import { assertPreflightCredits, InsufficientCreditsPreflightError } from '@server/utils/creditPreflight';
import { BadRequestError } from '@server/utils/errors';

// File size is used as a proxy for duration since the actual duration is not
// available pre-transcription. PCM baseline (16-bit 16kHz mono) is multiplied
// by COMPRESSION_FACTOR as a conservative factor to account for compressed
// formats (MP3, OGG, WebM) that can be 10-20x smaller than PCM for the same
// duration. This intentionally over-charges slightly to avoid free usage.
const COMPRESSION_FACTOR = 5;
const PCM_BYTES_PER_MINUTE = 16000 * 2 * 60;
const AWS_USD_PER_MINUTE = 0.024;
const OPENAI_USD_PER_MINUTE = 0.006;

// The cheapest backend's rate: a floor for pricing a call before the speech
// backend is resolved, so an early check never refuses what the real one admits.
export const MIN_TRANSCRIPTION_USD_PER_MINUTE = Math.min(AWS_USD_PER_MINUTE, OPENAI_USD_PER_MINUTE);

export function transcriptionUsdPerMinute(backend: string): number {
  return backend === 'aws' ? AWS_USD_PER_MINUTE : OPENAI_USD_PER_MINUTE;
}

export interface TranscriptionCost {
  durationMinutes: number;
  costUsd: number;
  credits: number;
}

export function estimateTranscriptionCost(contentLength: number, usdPerMinute: number): TranscriptionCost {
  const durationMinutes = (contentLength * COMPRESSION_FACTOR) / PCM_BYTES_PER_MINUTE;
  const costUsd = durationMinutes * usdPerMinute;
  return { durationMinutes, costUsd, credits: usdToCredits(costUsd) };
}

// Shared by both transcribe routes. Rethrown as BadRequestError to keep their
// established 400 for a caller who cannot pay.
export async function assertTranscriptionCredits(userId: string, estimatedCredits: number): Promise<void> {
  try {
    await assertPreflightCredits({ userId, estimatedCredits, featureLabel: 'transcription' });
  } catch (error) {
    if (error instanceof InsufficientCreditsPreflightError) throw new BadRequestError(error.message);
    throw error;
  }
}
