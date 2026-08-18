import {
  SoundGenerationVendor,
  UnprocessableEntityError,
  // From common, NOT @bike4mind/utils: keep this module free of the utils
  // barrel's server-only deps so a future client-side cost preview can import it.
  usdToCredits,
} from '@bike4mind/common';
import { ElevenLabsSoundCostCalculator } from '../llm/soundCostCalculator/ElevenLabsSoundCostCalculator';
import { SoundCost, SoundCostInput } from '../llm/soundCostCalculator/types';

/** Thrown when no cost calculator exists for a vendor. */
export class UnsupportedSoundVendorError extends Error {
  constructor(vendor: string) {
    super(`Sound generation vendor not supported: ${vendor}`);
    this.name = 'UnsupportedSoundVendorError';
  }
}

/** Resolves the vendor's cost calculator and computes cost + billed duration. */
function getSoundCost(vendor: SoundGenerationVendor, input: SoundCostInput): SoundCost {
  switch (vendor) {
    case 'elevenlabs':
      return new ElevenLabsSoundCostCalculator().getCost(input);
    default:
      throw new UnsupportedSoundVendorError(vendor);
  }
}

/** Raw provider cost (USD) for one sound-effects generation. */
export function computeSoundUsdCost(vendor: SoundGenerationVendor, input: SoundCostInput): number {
  return getSoundCost(vendor, input).usdCost;
}

/**
 * Estimates the credit cost of a sound-effects generation: provider USD cost
 * converted to internal credits (deterministic round-up, min 1). `usdCost` and
 * `billedSeconds` are carried through for usage-event analytics (COGS + units);
 * billing uses `requiredCredits`. `billedSeconds` is the duration the cost was
 * actually computed on - the request value, or the vendor auto-duration default.
 */
export function estimateSoundCredits(
  vendor: SoundGenerationVendor,
  input: SoundCostInput
): { requiredCredits: number; usdCost: number; billedSeconds: number } {
  const { usdCost, billedSeconds } = getSoundCost(vendor, input);
  const requiredCredits = usdToCredits(usdCost);
  if (!Number.isFinite(requiredCredits)) {
    throw new UnprocessableEntityError(`Unable to compute credit cost for sound vendor "${vendor}" (got ${usdCost}).`);
  }
  return { requiredCredits, usdCost, billedSeconds };
}
