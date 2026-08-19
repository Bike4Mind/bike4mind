import {
  MusicGenerationVendor,
  UnprocessableEntityError,
  // From common, NOT @bike4mind/utils: keep this module free of the utils
  // barrel's server-only deps so a future client-side cost preview can import it.
  usdToCredits,
} from '@bike4mind/common';
import { ElevenLabsMusicCostCalculator } from '../llm/musicCostCalculator/ElevenLabsMusicCostCalculator';
import { MusicCost, MusicCostInput } from '../llm/musicCostCalculator/types';

/** Thrown when no cost calculator exists for a vendor. */
export class UnsupportedMusicVendorError extends Error {
  constructor(vendor: string) {
    super(`Music generation vendor not supported: ${vendor}`);
    this.name = 'UnsupportedMusicVendorError';
  }
}

/** Resolves the vendor's cost calculator and computes cost + billed length. */
function getMusicCost(vendor: MusicGenerationVendor, input: MusicCostInput): MusicCost {
  switch (vendor) {
    case 'elevenlabs':
      return new ElevenLabsMusicCostCalculator().getCost(input);
    default:
      throw new UnsupportedMusicVendorError(vendor);
  }
}

/** Raw provider cost (USD) for one music generation. */
export function computeMusicUsdCost(vendor: MusicGenerationVendor, input: MusicCostInput): number {
  return getMusicCost(vendor, input).usdCost;
}

/**
 * Estimates the credit cost of a music generation: provider USD cost converted
 * to internal credits (deterministic round-up, min 1). `usdCost` and
 * `billedSeconds` are carried through for usage-event analytics (COGS + units);
 * billing uses `requiredCredits`.
 */
export function estimateMusicCredits(
  vendor: MusicGenerationVendor,
  input: MusicCostInput
): { requiredCredits: number; usdCost: number; billedSeconds: number } {
  const { usdCost, billedSeconds } = getMusicCost(vendor, input);
  const requiredCredits = usdToCredits(usdCost);
  if (!Number.isFinite(requiredCredits)) {
    throw new UnprocessableEntityError(`Unable to compute credit cost for music vendor "${vendor}" (got ${usdCost}).`);
  }
  return { requiredCredits, usdCost, billedSeconds };
}
