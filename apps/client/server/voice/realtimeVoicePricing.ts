import { IModelPrice, IModelPriceTier, isRealtimeVoiceTier, resolveModelPriceRow } from '@bike4mind/common';
import { DEFAULT_REALTIME_VOICE_MODEL, REALTIME_VOICE_PRICING } from '@bike4mind/llm-adapters';

export type RealtimeVoiceRateSource = 'catalog' | 'fallback' | 'fallback-default';

/**
 * Rates for settling one realtime voice session: the in-force catalog row
 * when it carries usable audio rates, else the adapter literal, else the
 * default model's rates with an [UNPRICED_MODEL] alarm (same tag and alert
 * as getTextModelCost). Always returns rates: voice settlement must never
 * bill zero or block on a missing price.
 */
export function pickRealtimeVoiceTier(
  model: string,
  rows: IModelPrice[],
  now: Date = new Date()
): { tier: IModelPriceTier; source: RealtimeVoiceRateSource } {
  const catalogRow = resolveModelPriceRow(rows, model, 'per_token', now);
  if (catalogRow) {
    const thresholds = Object.keys(catalogRow.pricing)
      .map(Number)
      .sort((a, b) => a - b);
    const tier = catalogRow.pricing[String(thresholds[0])];
    // A row without audio rates would settle audio tokens at 0; skip it.
    if (tier && isRealtimeVoiceTier(tier)) return { tier, source: 'catalog' };
  }
  const fallback = REALTIME_VOICE_PRICING[model];
  if (fallback) return { tier: fallback, source: 'fallback' };
  console.error(
    `[UNPRICED_MODEL] ${model} (realtime-voice) has no catalog row or fallback rates; settling at ${DEFAULT_REALTIME_VOICE_MODEL} rates`
  );
  return { tier: REALTIME_VOICE_PRICING[DEFAULT_REALTIME_VOICE_MODEL], source: 'fallback-default' };
}
