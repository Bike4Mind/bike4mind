import { describe, it, expect, vi, afterEach } from 'vitest';
import type { IModelPrice } from '@bike4mind/common';
import { REALTIME_VOICE_PRICING, DEFAULT_REALTIME_VOICE_MODEL } from '@bike4mind/llm-adapters';
import { pickRealtimeVoiceTier } from './realtimeVoicePricing';

const NOW = new Date('2026-07-10T12:00:00Z');

function row(modelId: string, pricing: IModelPrice['pricing']): IModelPrice {
  return {
    modelId,
    unit: 'per_token',
    pricing,
    effectiveFrom: new Date('2026-07-01T00:00:00Z'),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const CATALOG_TIER = {
  input: 5e-6,
  cache_read: 0.5e-6,
  output: 20e-6,
  audio_input: 40e-6,
  audio_cache_read: 0.5e-6,
  audio_output: 80e-6,
};

describe('pickRealtimeVoiceTier', () => {
  afterEach(() => vi.restoreAllMocks());

  it('bills from the catalog row when one is in force (reprices reach voice without a deploy)', () => {
    const rows = [row('gpt-realtime-1.5', { '0': CATALOG_TIER })];
    const picked = pickRealtimeVoiceTier('gpt-realtime-1.5', rows, NOW);
    expect(picked.source).toBe('catalog');
    expect(picked.tier).toMatchObject({ audio_output: 80e-6 });
  });

  it('ignores a catalog row without usable audio rates (a text-only row must not settle voice nearly free)', () => {
    const rows = [row('gpt-realtime-1.5', { '0': { input: 5e-6, output: 20e-6 } })];
    const picked = pickRealtimeVoiceTier('gpt-realtime-1.5', rows, NOW);
    expect(picked.source).toBe('fallback');
    expect(picked.tier).toEqual(REALTIME_VOICE_PRICING['gpt-realtime-1.5']);
  });

  it('falls back to the literal when no row is in force', () => {
    const picked = pickRealtimeVoiceTier('gpt-realtime-1.5', [], NOW);
    expect(picked.source).toBe('fallback');
    expect(picked.tier).toEqual(REALTIME_VOICE_PRICING['gpt-realtime-1.5']);
  });

  it('alarms and settles at default rates for a model unknown to catalog and literal alike', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const picked = pickRealtimeVoiceTier('gpt-realtime-99-mystery', [], NOW);
    expect(picked.source).toBe('fallback-default');
    expect(picked.tier).toEqual(REALTIME_VOICE_PRICING[DEFAULT_REALTIME_VOICE_MODEL]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('[UNPRICED_MODEL]');
    expect(error.mock.calls[0][0]).toContain('gpt-realtime-99-mystery');
  });
});
