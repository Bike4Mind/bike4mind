import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mocks, InsufficientCreditsPreflightError } = vi.hoisted(() => ({
  InsufficientCreditsPreflightError: class extends Error {},
  mocks: { assertPreflightCredits: vi.fn() },
}));

vi.mock('@bike4mind/utils', () => ({ usdToCredits: (usd: number) => Math.ceil(usd * 100) }));
vi.mock('@server/utils/creditPreflight', () => ({
  assertPreflightCredits: (...a: unknown[]) => mocks.assertPreflightCredits(...a),
  InsufficientCreditsPreflightError,
}));

import { BadRequestError } from '@server/utils/errors';
import {
  assertTranscriptionCredits,
  estimateTranscriptionCost,
  MIN_TRANSCRIPTION_USD_PER_MINUTE,
  transcriptionUsdPerMinute,
} from './transcriptionCost';

// One minute of 16-bit 16kHz mono PCM, divided by the compression factor.
const ONE_BILLED_MINUTE_BYTES = (16000 * 2 * 60) / 5;

beforeEach(() => {
  mocks.assertPreflightCredits.mockReset();
});

describe('estimateTranscriptionCost', () => {
  it('prices by size-derived duration at the given per-minute rate', () => {
    const cost = estimateTranscriptionCost(ONE_BILLED_MINUTE_BYTES * 10, transcriptionUsdPerMinute('aws'));
    expect(cost.durationMinutes).toBeCloseTo(10);
    expect(cost.costUsd).toBeCloseTo(0.24);
    expect(cost.credits).toBe(24);
  });

  it('never prices the backend-agnostic floor above a real backend', () => {
    for (const backend of ['aws', 'openai']) {
      expect(MIN_TRANSCRIPTION_USD_PER_MINUTE).toBeLessThanOrEqual(transcriptionUsdPerMinute(backend));
    }
  });
});

describe('assertTranscriptionCredits', () => {
  it('passes the estimate through to the shared pre-flight', async () => {
    mocks.assertPreflightCredits.mockResolvedValue(undefined);
    await assertTranscriptionCredits('u1', 7);
    expect(mocks.assertPreflightCredits).toHaveBeenCalledWith({
      userId: 'u1',
      estimatedCredits: 7,
      featureLabel: 'transcription',
    });
  });

  it('surfaces a refusal as the established 400', async () => {
    mocks.assertPreflightCredits.mockRejectedValue(new InsufficientCreditsPreflightError('broke'));
    await expect(assertTranscriptionCredits('u1', 7)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('lets unrelated failures through untouched', async () => {
    const boom = new Error('db down');
    mocks.assertPreflightCredits.mockRejectedValue(boom);
    await expect(assertTranscriptionCredits('u1', 7)).rejects.toBe(boom);
  });
});
