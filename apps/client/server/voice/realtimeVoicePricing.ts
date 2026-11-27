import { IModelPrice, IModelPriceTier, billableRealtimeVoiceTier, resolveModelPriceRow } from '@bike4mind/common';
import { DEFAULT_REALTIME_VOICE_MODEL, REALTIME_VOICE_PRICING } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'realtimeVoicePricing' } });

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
  // A row without audio rates would settle audio tokens at 0; skip it.
  const tier = catalogRow ? billableRealtimeVoiceTier(catalogRow.pricing) : undefined;
  if (tier) return { tier, source: 'catalog' };
  const fallback = REALTIME_VOICE_PRICING[model];
  if (fallback) return { tier: fallback, source: 'fallback' };
  logger.error(
    '[UNPRICED_MODEL] realtime-voice model has no catalog row or fallback rates; settling at the default rates',
    {
      model,
      defaultModel: DEFAULT_REALTIME_VOICE_MODEL,
    }
  );
  return { tier: REALTIME_VOICE_PRICING[DEFAULT_REALTIME_VOICE_MODEL], source: 'fallback-default' };
}
