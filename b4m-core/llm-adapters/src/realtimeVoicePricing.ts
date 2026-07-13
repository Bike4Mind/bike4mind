import { IModelPriceTier } from '@bike4mind/common';

/**
 * Provider USD rates for realtime voice models, per token. The catalog seed
 * derives from this table (generateModelPriceSeed), and voiceSessionEnded
 * falls back to it when the catalog has no row - same literal-fallback role
 * the adapter getModelInfo tables play for text models. Reprice by editing
 * here and regenerating the seed; do not hand-edit modelPrices.seed.json.
 */
export const REALTIME_VOICE_PRICING: Record<string, IModelPriceTier> = {
  'gpt-realtime-1.5': {
    input: 4 / 1_000_000,
    cache_read: 0.4 / 1_000_000,
    output: 16 / 1_000_000,
    audio_input: 32 / 1_000_000,
    audio_cache_read: 0.4 / 1_000_000,
    audio_output: 64 / 1_000_000,
  },
};

/** Rates used when a session reports a model unknown to catalog and table alike. */
export const DEFAULT_REALTIME_VOICE_MODEL = 'gpt-realtime-1.5';
