import { VoiceGenerationVendor } from './voiceGeneration';

/**
 * Text-to-speech is billed per input CHARACTER, not per token - so it does not
 * fit the token-based modelPriceCatalog. Rates below are the provider's raw USD
 * cost per 1,000 input characters, keyed by model.
 *
 * Sources (2026-07, keep in sync with each provider's pricing page):
 * - OpenAI Speech API:   tts-1 $15 / tts-1-hd $30 per 1M chars.
 * - ElevenLabs ElevenAPI: Flash/Turbo $0.05, Multilingual v2/v3 $0.10 per 1K chars.
 *   ElevenLabs' effective rate is plan-dependent; these are the pay-as-you-go
 *   rates and are treated as an approximation of the admin key's real cost.
 */
type TtsRateTable = Record<string, number>;

const OPENAI_TTS_RATES: TtsRateTable = {
  'tts-1': 0.015,
  'tts-1-hd': 0.03,
};

const ELEVENLABS_TTS_RATES: TtsRateTable = {
  eleven_multilingual_v2: 0.1,
  eleven_multilingual_v1: 0.1,
  eleven_monolingual_v1: 0.1,
  eleven_turbo_v2_5: 0.05,
  eleven_turbo_v2: 0.05,
  eleven_flash_v2_5: 0.05,
  eleven_flash_v2: 0.05,
};

const VENDOR_RATES: Record<VoiceGenerationVendor, TtsRateTable> = {
  openai: OPENAI_TTS_RATES,
  elevenlabs: ELEVENLABS_TTS_RATES,
};

/**
 * Fallback USD per 1K chars when the exact model is not in the table. Set to the
 * HIGHEST known rate for the vendor so an unknown or newly-shipped model bills at
 * a conservative rate rather than slipping through free (fail toward overcharge,
 * never toward a free call - this is the anti-abuse guarantee).
 */
const VENDOR_FALLBACK_USD_PER_1K: Record<VoiceGenerationVendor, number> = {
  openai: 0.03,
  elevenlabs: 0.1,
};

/** Provider USD per 1,000 input characters for the given vendor + model. */
export function ttsUsdPer1kChars(vendor: VoiceGenerationVendor, model?: string): number {
  const table = VENDOR_RATES[vendor];
  const rate = model ? table[model] : undefined;
  return rate ?? VENDOR_FALLBACK_USD_PER_1K[vendor];
}

/**
 * Raw provider USD cost for synthesizing `characters` input characters with the
 * given vendor + model. Returns 0 for non-positive/non-finite input. Convert to
 * credits with usdToCredits (estimate) or usdToCreditsStochastic (settlement).
 */
export function computeTtsUsd(vendor: VoiceGenerationVendor, model: string | undefined, characters: number): number {
  if (!Number.isFinite(characters) || characters <= 0) return 0;
  return (characters / 1000) * ttsUsdPer1kChars(vendor, model);
}
