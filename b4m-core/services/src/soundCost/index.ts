import {
  SoundGenerationVendor,
  UnprocessableEntityError,
  // From common, NOT @bike4mind/utils: keep this module free of the utils
  // barrel's server-only deps so a future client-side cost preview can import it.
  usdToCredits,
} from '@bike4mind/common';
import { ElevenLabsSoundCostCalculator } from '../llm/soundCostCalculator/ElevenLabsSoundCostCalculator';
import { SoundCostInput } from '../llm/soundCostCalculator/types';

/** Thrown when no cost calculator exists for a vendor. */
export class UnsupportedSoundVendorError extends Error {
  constructor(vendor: string) {
    super(`Sound generation vendor not supported: ${vendor}`);
    this.name = 'UnsupportedSoundVendorError';
  }
}

/** Raw provider cost (USD) for one sound-effects generation. */
export function computeSoundUsdCost(vendor: SoundGenerationVendor, input: SoundCostInput): number {
  switch (vendor) {
    case 'elevenlabs':
      return new ElevenLabsSoundCostCalculator().getCost(input);
    default:
      throw new UnsupportedSoundVendorError(vendor);
  }
}

/**
 * Estimates the credit cost of a sound-effects generation: provider USD cost
 * converted to internal credits (deterministic round-up, min 1). `usdCost` is
 * carried through for usage-event analytics; billing uses `requiredCredits`.
 */
export function estimateSoundCredits(
  vendor: SoundGenerationVendor,
  input: SoundCostInput
): { requiredCredits: number; usdCost: number } {
  const usdCost = computeSoundUsdCost(vendor, input);
  const requiredCredits = usdToCredits(usdCost);
  if (!Number.isFinite(requiredCredits)) {
    throw new UnprocessableEntityError(`Unable to compute credit cost for sound vendor "${vendor}" (got ${usdCost}).`);
  }
  return { requiredCredits, usdCost };
}
