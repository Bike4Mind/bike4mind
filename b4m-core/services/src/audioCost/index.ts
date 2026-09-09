import {
  computeTtsUsd,
  SoundGenerationVendor,
  UnprocessableEntityError,
  // From common, NOT @bike4mind/utils: keep this module free of the utils
  // barrel's server-only deps so a future client-side cost preview can import it.
  usdToCredits,
  VoiceGenerationVendor,
} from '@bike4mind/common';
import { estimateSoundCredits } from '../soundCost';

/**
 * Cost input for the model-callable `audio_generation` tool. A discriminated union
 * because the two modes bill on different units: speech per input CHARACTER
 * (provider + resolved model aware), sound effects per DURATION second.
 */
export type AudioCostInput =
  | { kind: 'speech'; provider: VoiceGenerationVendor; model?: string; characters: number }
  | { kind: 'sound_effect'; provider: SoundGenerationVendor; durationSeconds?: number };

/**
 * Estimates the credit cost of one audio generation and carries `usdCost` + `units`
 * through for usage-event analytics (COGS + billable units); billing uses
 * `requiredCredits`.
 *
 * Speech reuses the exact same math as the direct `/api/ai/tts` endpoint
 * (`usdToCredits(computeTtsUsd(...))`, see deductTtsCredits) so a tool-driven
 * synthesis and a direct one charge identically. Sound effects delegate to
 * `estimateSoundCredits`, the same estimator the `/api/ai/sound-effects` endpoint uses.
 */
export function estimateAudioCredits(input: AudioCostInput): {
  requiredCredits: number;
  usdCost: number;
  units: number;
} {
  if (input.kind === 'sound_effect') {
    const { requiredCredits, usdCost, billedSeconds } = estimateSoundCredits(input.provider, {
      durationSeconds: input.durationSeconds,
    });
    return { requiredCredits, usdCost, units: billedSeconds };
  }

  const usdCost = computeTtsUsd(input.provider, input.model, input.characters);
  const requiredCredits = usdToCredits(usdCost);
  if (!Number.isFinite(requiredCredits)) {
    throw new UnprocessableEntityError(
      `Unable to compute credit cost for TTS vendor "${input.provider}" (got ${usdCost}).`
    );
  }
  return { requiredCredits, usdCost, units: input.characters };
}
