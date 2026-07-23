import { SoundCost, SoundCostCalculator } from './types';

/**
 * ElevenLabs sound-effects pricing. Billed by generated audio length at
 * $0.12/minute when billed directly. When no duration is requested the
 * provider auto-selects one and charges a flat default (~200 of ElevenLabs'
 * own credits, i.e. the 11-credits/sec rate x ~18.2s); we bill that same
 * default-duration equivalent so an omitted duration isn't under-charged.
 * See https://elevenlabs.io/pricing/api and ElevenLabs' sound-effects cost FAQ.
 */
const USD_PER_SECOND = 0.12 / 60; // $0.002
const DEFAULT_DURATION_SECONDS = 200 / 11; // ~18.18s auto-duration equivalent

export interface ElevenLabsSoundCostInput {
  durationSeconds?: number;
}

export class ElevenLabsSoundCostCalculator implements SoundCostCalculator<ElevenLabsSoundCostInput> {
  getCost(input: ElevenLabsSoundCostInput): SoundCost {
    const billedSeconds = input.durationSeconds ?? DEFAULT_DURATION_SECONDS;
    return { usdCost: billedSeconds * USD_PER_SECOND, billedSeconds };
  }
}
