import {
  estimateTtsCreditCost,
  supportedVoiceGenerationVendor,
  TTS_DEFAULT_MODEL,
  TTS_MAX_INPUT_CHARS,
  type VoiceGenerationVendor,
} from '@bike4mind/common';

export function ttsCandidates(provider: VoiceGenerationVendor, characters: number): VoiceGenerationVendor[] {
  return [
    provider,
    ...supportedVoiceGenerationVendor.options.filter(
      vendor => vendor !== provider && characters <= TTS_MAX_INPUT_CHARS[vendor]
    ),
  ];
}

/** Reserve enough for any attempted provider; settlement refunds the unused balance. */
export function estimateTtsHoldCredits(
  provider: VoiceGenerationVendor,
  model: string | undefined,
  characters: number
): number {
  return Math.max(
    ...ttsCandidates(provider, characters).map(vendor =>
      estimateTtsCreditCost(
        vendor,
        vendor === provider ? (model ?? TTS_DEFAULT_MODEL[vendor]) : TTS_DEFAULT_MODEL[vendor],
        characters
      )
    )
  );
}
