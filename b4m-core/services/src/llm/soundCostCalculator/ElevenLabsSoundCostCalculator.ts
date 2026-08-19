// Rate table + formula live in @bike4mind/common (computeSoundUsdCost) so the
// server billing path and the client-side cost preview share one definition.
import { computeSoundUsdCost } from '@bike4mind/common';
import { SoundCost, SoundCostCalculator } from './types';

export interface ElevenLabsSoundCostInput {
  durationSeconds?: number;
}

export class ElevenLabsSoundCostCalculator implements SoundCostCalculator<ElevenLabsSoundCostInput> {
  getCost(input: ElevenLabsSoundCostInput): SoundCost {
    return computeSoundUsdCost('elevenlabs', input);
  }
}
