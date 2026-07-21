import { ElevenLabsSoundCostInput } from './ElevenLabsSoundCostCalculator';

export type SoundCostInput = ElevenLabsSoundCostInput;

/**
 * Computes the raw provider cost (USD) of a single sound-effects generation.
 * Conversion to internal credits happens downstream via `usdToCredits`.
 */
export interface SoundCostCalculator<T extends SoundCostInput> {
  getCost(input: T): number;
}
