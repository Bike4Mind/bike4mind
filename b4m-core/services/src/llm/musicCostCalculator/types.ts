import { ElevenLabsMusicCostInput } from './ElevenLabsMusicCostCalculator';

export type MusicCostInput = ElevenLabsMusicCostInput;

/** Raw provider cost of one music generation. */
export interface MusicCost {
  /** Provider cost in USD. */
  usdCost: number;
  /**
   * Effective track length billed, in seconds. Drives usage-event analytics
   * `units`, so it must match what the cost was actually computed on.
   */
  billedSeconds: number;
}

/**
 * Computes the raw provider cost of a single music generation.
 * Conversion to internal credits happens downstream via `usdToCredits`.
 */
export interface MusicCostCalculator<T extends MusicCostInput> {
  getCost(input: T): MusicCost;
}
