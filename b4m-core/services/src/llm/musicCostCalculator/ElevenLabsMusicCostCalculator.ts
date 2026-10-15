import { MusicCost, MusicCostCalculator } from './types';

/**
 * ElevenLabs music pricing. Billed by generated track length at $0.15/minute
 * when billed directly (vs. $0.12/min for sound effects). Because the route
 * forces the requested length on the provider, the generated length always
 * equals the length billed here - there is no vendor auto-duration to reconcile.
 * See https://elevenlabs.io/pricing/api.
 */
const USD_PER_SECOND = 0.15 / 60; // $0.0025

export interface ElevenLabsMusicCostInput {
  /** Required, with no fallback here: the billed length must be the exact length the caller sends the
   * provider, so the default is applied once, upstream (musicRequestSchema), never in two places. */
  lengthMs: number;
}

export class ElevenLabsMusicCostCalculator implements MusicCostCalculator<ElevenLabsMusicCostInput> {
  getCost(input: ElevenLabsMusicCostInput): MusicCost {
    const billedSeconds = input.lengthMs / 1000;
    return { usdCost: billedSeconds * USD_PER_SECOND, billedSeconds };
  }
}
