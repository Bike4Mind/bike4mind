import { usdToCredits } from './pricing';
import { SoundGenerationVendor } from './soundGeneration';

/**
 * ElevenLabs sound-effects pricing. Billed by generated audio length at
 * $0.12/minute when billed directly. When no duration is requested the provider
 * auto-selects one and charges a flat default (~200 of ElevenLabs' own credits,
 * i.e. the 11-credits/sec rate x ~18.2s); we bill that same default-duration
 * equivalent so an omitted duration isn't under-charged.
 * See https://elevenlabs.io/pricing/api and ElevenLabs' sound-effects cost FAQ.
 *
 * Lives in common (not @bike4mind/utils/services) so both the server billing
 * path and a client-side cost preview share one definition. The server's
 * ElevenLabsSoundCostCalculator delegates here - they MUST stay in sync.
 */
const ELEVENLABS_USD_PER_SECOND = 0.12 / 60; // $0.002
const ELEVENLABS_DEFAULT_DURATION_SECONDS = 200 / 11; // ~18.18s auto-duration equivalent

export interface SoundCostInput {
  durationSeconds?: number;
}

export interface SoundUsdCost {
  /** Provider cost in USD. */
  usdCost: number;
  /**
   * Effective audio length billed, in seconds: the requested duration, or the
   * vendor's auto-duration default when none was requested.
   */
  billedSeconds: number;
}

/** Raw provider USD cost + effective billed duration for one sound-effects generation. */
export function computeSoundUsdCost(_vendor: SoundGenerationVendor, input: SoundCostInput): SoundUsdCost {
  const billedSeconds = input.durationSeconds ?? ELEVENLABS_DEFAULT_DURATION_SECONDS;
  return { usdCost: billedSeconds * ELEVENLABS_USD_PER_SECOND, billedSeconds };
}

/**
 * Estimated internal credit cost of a sound-effects generation. Client-safe
 * (pure, no server deps) for the pre-generation credit hint; the authoritative
 * charge is computed server-side from the same rate table.
 */
export function estimateSoundCreditCost(vendor: SoundGenerationVendor, input: SoundCostInput): number {
  return usdToCredits(computeSoundUsdCost(vendor, input).usdCost);
}
