import { DEFAULT_MUSIC_LENGTH_MS } from '@bike4mind/common';
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
  lengthMs?: number;
}

export class ElevenLabsMusicCostCalculator implements MusicCostCalculator<ElevenLabsMusicCostInput> {
  getCost(input: ElevenLabsMusicCostInput): MusicCost {
    const billedSeconds = (input.lengthMs ?? DEFAULT_MUSIC_LENGTH_MS) / 1000;
    return { usdCost: billedSeconds * USD_PER_SECOND, billedSeconds };
  }
}
