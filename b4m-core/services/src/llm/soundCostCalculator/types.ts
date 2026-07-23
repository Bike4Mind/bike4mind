import { ElevenLabsSoundCostInput } from './ElevenLabsSoundCostCalculator';

export type SoundCostInput = ElevenLabsSoundCostInput;

/** Raw provider cost of one sound-effects generation. */
export interface SoundCost {
  /** Provider cost in USD. */
  usdCost: number;
  /**
   * Effective audio length billed, in seconds: the requested duration, or the
   * vendor's auto-duration default when none was requested. Drives usage-event
   * analytics `units`, so it must match what the cost was actually computed on.
   */
  billedSeconds: number;
}

/**
 * Computes the raw provider cost of a single sound-effects generation.
 * Conversion to internal credits happens downstream via `usdToCredits`.
 */
export interface SoundCostCalculator<T extends SoundCostInput> {
  getCost(input: T): SoundCost;
}
