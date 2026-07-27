import type { IModelPrice, IModelPriceTier } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { describePriceRows, planPriceWrites, type PricePlanInput } from './pricePlan';
import type { DiscoveredModel, DiscoveredPrice, SourceContribution } from './types';

const RUN_AT = new Date('2026-07-26T10:00:00Z');
const IN_FORCE_AT = new Date('2026-01-01T00:00:00Z');

/** Anthropic's published Opus 4.5 rate, the one the conversion is checked against. */
const OPUS_INPUT_PER_MTOK = 5;
const OPUS_OUTPUT_PER_MTOK = 25;

const priced = (price: DiscoveredPrice, modelId = 'gpt-6'): DiscoveredModel => ({ modelId, patch: {}, pricing: price });

const from = (name: string, kind: SourceContribution['kind'], ...records: DiscoveredModel[]): SourceContribution => ({
  name,
  kind,
  records,
});

const provider = (price: DiscoveredPrice, modelId?: string) => from('openai', 'provider', priced(price, modelId));
const modelsDev = (price: DiscoveredPrice, modelId?: string) =>
  from('models.dev', 'aggregator', priced(price, modelId));
const litellm = (price: DiscoveredPrice, modelId?: string) => from('litellm', 'aggregator', priced(price, modelId));

const inForce = (pricing: Record<string, IModelPriceTier>, note = 'adapter-seed', modelId = 'gpt-6'): IModelPrice => ({
  modelId,
  unit: 'per_token',
  pricing,
  effectiveFrom: IN_FORCE_AT,
  note,
  createdAt: IN_FORCE_AT,
  updatedAt: IN_FORCE_AT,
});

/** $5/$25 per MTok as the collection stores it: USD per single token. */
const FIVE_AND_TWENTY_FIVE: IModelPriceTier = { input: 5e-6, output: 25e-6 };

const plan = (overrides: Partial<PricePlanInput> = {}) =>
  planPriceWrites({
    contributions: [],
    rowsInForce: [],
    knownModelIds: new Set(['gpt-6']),
    bandPct: 50,
    runStartedAt: RUN_AT,
    ...overrides,
  });

describe('planPriceWrites units', () => {
  it('divides per-MTok by 1e6 so a published rate lands as USD per single token', () => {
    const result = plan({
      contributions: [provider({ inputPerMTok: OPUS_INPUT_PER_MTOK, outputPerMTok: OPUS_OUTPUT_PER_MTOK })],
    });

    // The whole guardrail: $5/MTok is 0.000005 per token. Storing 5 here would
    // bill a million times the real price.
    expect(result.rows[0].pricing['0']).toEqual({ input: 0.000005, output: 0.000025 });
  });

  it('round-trips a fractional rate without drift', () => {
    // GPT-5's published $1.25 / $10 per MTok.
    const result = plan({ contributions: [provider({ inputPerMTok: 1.25, outputPerMTok: 10 })] });

    expect(result.rows[0].pricing['0']).toEqual({ input: 1.25e-6, output: 1e-5 });
  });

  it('reports the plan back in per-MTok, which is the unit an operator reads', () => {
    const result = plan({ contributions: [provider({ inputPerMTok: 1.25, outputPerMTok: 10 })] });

    expect(describePriceRows(result.rows)).toEqual([
      {
        modelId: 'gpt-6',
        unit: 'per_token',
        inputPerMTok: 1.25,
        outputPerMTok: 10,
        effectiveFrom: RUN_AT,
        sources: ['openai'],
        note: `discovery:openai@${RUN_AT.toISOString()}`,
      },
    ]);
  });
});

describe('planPriceWrites trust tiers', () => {
  it('writes a provider price for a catalog model nothing has priced yet', () => {
    const result = plan({ contributions: [provider({ inputPerMTok: 2, outputPerMTok: 8 })] });

    expect(result.flags).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      modelId: 'gpt-6',
      unit: 'per_token',
      effectiveFrom: RUN_AT,
      note: `discovery:openai@${RUN_AT.toISOString()}`,
      repricedBy: 'model-discovery',
    });
  });

  it('writes the models.dev value when both aggregators agree, and credits both', () => {
    const result = plan({
      contributions: [
        modelsDev({ inputPerMTok: 5, outputPerMTok: 25 }),
        litellm({ inputPerMTok: 5.2, outputPerMTok: 25.5 }),
      ],
    });

    expect(result.rows[0].pricing['0'].input).toBe(5e-6);
    expect(result.rows[0].note).toBe(`discovery:models.dev+litellm@${RUN_AT.toISOString()}`);
  });

  it('prefers the provider over an agreeing aggregator, for both the value and the note', () => {
    const result = plan({
      contributions: [
        modelsDev({ inputPerMTok: 5.4, outputPerMTok: 25 }),
        provider({ inputPerMTok: 5, outputPerMTok: 25 }),
      ],
    });

    expect(result.rows[0].pricing['0'].input).toBe(5e-6);
    expect(result.rows[0].note).toBe(`discovery:openai@${RUN_AT.toISOString()}`);
  });

  it('flags a lone aggregator on an unpriced model instead of trusting it', () => {
    const result = plan({ contributions: [litellm({ inputPerMTok: 5, outputPerMTok: 25 })] });

    expect(result.rows).toEqual([]);
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]).toMatchObject({
      modelId: 'gpt-6',
      kind: 'single-source-untrusted',
      proposed: { inputPerMTok: 5, outputPerMTok: 25 },
      sources: ['litellm'],
    });
    expect(result.flags[0].detail).toContain('litellm');
  });

  it('stays silent when a lone aggregator merely agrees with the row in force', () => {
    const result = plan({
      contributions: [litellm({ inputPerMTok: 5.2, outputPerMTok: 25 })],
      rowsInForce: [inForce({ '0': FIVE_AND_TWENTY_FIVE })],
    });

    expect(result.rows).toEqual([]);
    expect(result.flags).toEqual([]);
    expect(result.skipped).toEqual([{ modelId: 'gpt-6', reason: 'untrusted' }]);
  });

  it('flags a lone aggregator that contradicts the row in force', () => {
    const result = plan({
      contributions: [litellm({ inputPerMTok: 9, outputPerMTok: 25 })],
      rowsInForce: [inForce({ '0': FIVE_AND_TWENTY_FIVE })],
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({
      kind: 'single-source-untrusted',
      current: { inputPerMTok: 5, outputPerMTok: 25 },
    });
  });
});

describe('planPriceWrites guardrails', () => {
  it('applies neither side when the two aggregators disagree beyond the tolerance', () => {
    const result = plan({
      contributions: [
        modelsDev({ inputPerMTok: 5, outputPerMTok: 25 }),
        litellm({ inputPerMTok: 9, outputPerMTok: 25 }),
      ],
      rowsInForce: [inForce({ '0': FIVE_AND_TWENTY_FIVE })],
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'source-disagreement', sources: ['models.dev', 'litellm'] });
    // Both sides named: "flag, keep the in-force row, apply neither" is only
    // actionable if the operator can see who said what.
    expect(result.flags[0].detail).toContain('models.dev');
    expect(result.flags[0].detail).toContain('litellm');
  });

  it('applies neither side when a provider and an aggregator disagree', () => {
    const result = plan({
      contributions: [
        modelsDev({ inputPerMTok: 5, outputPerMTok: 25 }),
        provider({ inputPerMTok: 15, outputPerMTok: 25 }),
      ],
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0].kind).toBe('source-disagreement');
  });

  it('flags a move beyond the band and keeps the row in force', () => {
    const result = plan({
      contributions: [provider({ inputPerMTok: 12, outputPerMTok: 25 })],
      rowsInForce: [inForce({ '0': FIVE_AND_TWENTY_FIVE })],
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({
      kind: 'band-exceeded',
      proposed: { inputPerMTok: 12, outputPerMTok: 25 },
      current: { inputPerMTok: 5, outputPerMTok: 25 },
    });
  });

  it('applies the same move once the band is widened past it', () => {
    // The band is a multiple of the rate in force, so 200% passes anything up to
    // 3x: $5 -> $12 is a 140% move.
    const result = plan({
      contributions: [provider({ inputPerMTok: 12, outputPerMTok: 25 })],
      rowsInForce: [inForce({ '0': FIVE_AND_TWENTY_FIVE })],
      bandPct: 200,
    });

    expect(result.flags).toEqual([]);
    expect(result.rows[0].pricing['0'].input).toBe(12e-6);
  });

  it('still flags a 10x move against a widened band', () => {
    // A symmetric distance saturates at 100%, which would make every band of 100
    // or more a no-op; against the rate in force this is a 900% move.
    const result = plan({
      contributions: [provider({ inputPerMTok: 50, outputPerMTok: 25 })],
      rowsInForce: [inForce({ '0': FIVE_AND_TWENTY_FIVE })],
      bandPct: 200,
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'band-exceeded', proposed: { inputPerMTok: 50 } });
  });

  it('drops a price for a model no catalog row covers', () => {
    const result = plan({
      contributions: [provider({ inputPerMTok: 5, outputPerMTok: 25 }, 'gpt-hallucinated')],
      knownModelIds: new Set(['gpt-6']),
    });

    expect(result.rows).toEqual([]);
    expect(result.flags).toEqual([]);
    expect(result.skipped).toEqual([{ modelId: 'gpt-hallucinated', reason: 'unknown-model' }]);
  });

  it('drops an all-zero observation rather than writing a free row', () => {
    const result = plan({ contributions: [provider({ inputPerMTok: 0, outputPerMTok: 0 })] });

    expect(result).toEqual({ rows: [], flags: [], skipped: [] });
  });
});

describe('planPriceWrites provenance', () => {
  it('never supersedes an operator row, and flags only a real divergence', () => {
    const diverging = plan({
      contributions: [provider({ inputPerMTok: 8, outputPerMTok: 30 })],
      rowsInForce: [inForce({ '0': FIVE_AND_TWENTY_FIVE }, 'manual reprice')],
    });

    expect(diverging.rows).toEqual([]);
    expect(diverging.flags[0]).toMatchObject({ kind: 'operator-owned-divergence' });

    const agreeing = plan({
      contributions: [provider({ inputPerMTok: 5.2, outputPerMTok: 25 })],
      rowsInForce: [inForce({ '0': FIVE_AND_TWENTY_FIVE }, 'manual reprice')],
    });

    // Report-mode exit criterion 1 is zero PROPOSED diffs against operator
    // rows; a divergence note is a flag, never a row.
    expect(agreeing.rows).toEqual([]);
    expect(agreeing.flags).toEqual([]);
    expect(agreeing.skipped).toEqual([{ modelId: 'gpt-6', reason: 'operator-owned' }]);
  });

  it('treats a row with no note as operator-owned', () => {
    const result = plan({
      contributions: [provider({ inputPerMTok: 8, outputPerMTok: 30 })],
      rowsInForce: [{ ...inForce({ '0': FIVE_AND_TWENTY_FIVE }), note: undefined }],
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0].kind).toBe('operator-owned-divergence');
  });

  it('supersedes its own earlier row', () => {
    const result = plan({
      contributions: [provider({ inputPerMTok: 6, outputPerMTok: 25 })],
      rowsInForce: [inForce({ '0': FIVE_AND_TWENTY_FIVE }, 'discovery:openai@2026-01-01T00:00:00.000Z')],
    });

    expect(result.rows[0].pricing['0'].input).toBe(6e-6);
  });

  it('refuses to flatten a tier ladder, and flags only a real divergence', () => {
    const ladder = { '0': FIVE_AND_TWENTY_FIVE, '200000': { input: 10e-6, output: 50e-6 } };

    const diverging = plan({
      contributions: [provider({ inputPerMTok: 8, outputPerMTok: 25 })],
      rowsInForce: [inForce(ladder)],
    });

    expect(diverging.rows).toEqual([]);
    expect(diverging.flags[0]).toMatchObject({ kind: 'tiered-pricing-manual' });

    const agreeing = plan({
      contributions: [provider({ inputPerMTok: 5, outputPerMTok: 25 })],
      rowsInForce: [inForce(ladder)],
    });

    expect(agreeing.rows).toEqual([]);
    expect(agreeing.flags).toEqual([]);
    expect(agreeing.skipped).toEqual([{ modelId: 'gpt-6', reason: 'tiered-pricing' }]);
  });

  it('treats a single tier keyed above zero as flat, not as a ladder', () => {
    // The seed keys its single tier at the context window, so reading '0' as the
    // only flat shape would leave nearly every seeded model unrepricable forever.
    const result = plan({
      contributions: [provider({ inputPerMTok: 8, outputPerMTok: 25 })],
      rowsInForce: [inForce({ '200000': FIVE_AND_TWENTY_FIVE })],
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0].kind).toBe('band-exceeded');
  });

  it('supersedes a seed-keyed row under the same key it already uses', () => {
    const result = plan({
      contributions: [provider({ inputPerMTok: 6, outputPerMTok: 25 })],
      rowsInForce: [inForce({ '200000': FIVE_AND_TWENTY_FIVE })],
    });

    expect(result.flags).toEqual([]);
    // Re-keying to '0' would churn the seed's threshold convention on every run.
    expect(Object.keys(result.rows[0].pricing)).toEqual(['200000']);
    expect(result.rows[0].pricing['200000'].input).toBe(6e-6);
  });
});

describe('planPriceWrites idempotence and carry-forward', () => {
  const asInForce = (row: {
    modelId: string;
    pricing: Record<string, IModelPriceTier>;
    note?: string;
  }): IModelPrice => ({
    modelId: row.modelId,
    unit: 'per_token',
    pricing: row.pricing,
    effectiveFrom: RUN_AT,
    note: row.note,
    createdAt: RUN_AT,
    updatedAt: RUN_AT,
  });

  it('appends nothing on a second plan over the row it just wrote', () => {
    const contributions = [provider({ inputPerMTok: 5, outputPerMTok: 25 })];
    const first = plan({ contributions });

    const second = plan({ contributions, rowsInForce: [asInForce(first.rows[0])] });

    expect(second.rows).toEqual([]);
    expect(second.flags).toEqual([]);
    expect(second.skipped).toEqual([{ modelId: 'gpt-6', reason: 'unchanged' }]);
  });

  it('carries forward the cache and audio rates no feed publishes', () => {
    const result = plan({
      contributions: [provider({ inputPerMTok: 6, outputPerMTok: 25 })],
      rowsInForce: [
        inForce(
          {
            '0': {
              ...FIVE_AND_TWENTY_FIVE,
              cache_read: 0.5e-6,
              cache_write: 6.25e-6,
              audio_input: 40e-6,
              audio_output: 80e-6,
            },
          },
          'discovery:openai@2026-01-01T00:00:00.000Z'
        ),
      ],
    });

    // Dropping these would silently move cached reads and voice minutes onto
    // the text rate, which is a reprice nobody asked for.
    expect(result.rows[0].pricing['0']).toEqual({
      input: 6e-6,
      output: 25e-6,
      cache_read: 0.5e-6,
      cache_write: 6.25e-6,
      audio_input: 40e-6,
      audio_output: 80e-6,
    });
  });

  it('prefers an observed cache rate over the carried one', () => {
    const result = plan({
      contributions: [provider({ inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.25, cacheWritePerMTok: 5 })],
      rowsInForce: [
        inForce(
          { '0': { ...FIVE_AND_TWENTY_FIVE, cache_read: 0.5e-6, cache_write: 6.25e-6 } },
          'discovery:openai@2026-01-01T00:00:00.000Z'
        ),
      ],
    });

    expect(result.rows[0].pricing['0']).toEqual({
      input: 5e-6,
      output: 25e-6,
      cache_read: 0.25e-6,
      cache_write: 5e-6,
    });
  });

  it('flags a cache rate the two sources disagree about', () => {
    // The repo's own aggregator fixtures do exactly this for grok-4.5: the text
    // rates match to the cent and the cache rates are 0.5 against 0.3.
    const result = plan({
      contributions: [
        modelsDev({ inputPerMTok: 2, outputPerMTok: 6, cacheReadPerMTok: 0.3 }),
        litellm({ inputPerMTok: 2, outputPerMTok: 6, cacheReadPerMTok: 0.5 }),
      ],
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'source-disagreement', sources: ['models.dev', 'litellm'] });
  });

  it('does not read a cache rate only one source publishes as a disagreement', () => {
    const result = plan({
      contributions: [
        modelsDev({ inputPerMTok: 2, outputPerMTok: 6, cacheReadPerMTok: 0.3 }),
        litellm({ inputPerMTok: 2, outputPerMTok: 6 }),
      ],
    });

    expect(result.flags).toEqual([]);
    expect(result.rows[0].pricing['0'].cache_read).toBe(0.3e-6);
  });

  it('writes the one cache rate a source publishes and carries the other forward', () => {
    const result = plan({
      contributions: [provider({ inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.25 })],
      rowsInForce: [
        inForce(
          { '0': { ...FIVE_AND_TWENTY_FIVE, cache_read: 0.5e-6, cache_write: 6.25e-6 } },
          'discovery:openai@2026-01-01T00:00:00.000Z'
        ),
      ],
    });

    expect(result.rows[0].pricing['0']).toEqual({
      input: 5e-6,
      output: 25e-6,
      cache_read: 0.25e-6,
      cache_write: 6.25e-6,
    });
  });

  it('bands a cache rate against the row in force like any other rate', () => {
    const result = plan({
      contributions: [provider({ inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 5 })],
      rowsInForce: [
        inForce({ '0': { ...FIVE_AND_TWENTY_FIVE, cache_read: 0.5e-6 } }, 'discovery:openai@2026-01-01T00:00:00.000Z'),
      ],
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0].kind).toBe('band-exceeded');
    expect(result.flags[0].detail).toContain('cache_read');
  });

  it('drops a published cache rate of zero and keeps the carried one', () => {
    // A stored cache_read of 0 would defeat getTextModelCost's fallback to
    // input * CACHE_READ_MULTIPLIER and settle every cached read free.
    const result = plan({
      contributions: [provider({ inputPerMTok: 6, outputPerMTok: 25, cacheReadPerMTok: 0 })],
      rowsInForce: [
        inForce({ '0': { ...FIVE_AND_TWENTY_FIVE, cache_read: 0.5e-6 } }, 'discovery:openai@2026-01-01T00:00:00.000Z'),
      ],
    });

    expect(result.rows[0].pricing['0']).toEqual({ input: 6e-6, output: 25e-6, cache_read: 0.5e-6 });
  });

  it('treats a cache-rate-only change as a change', () => {
    const contributions = [provider({ inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.25 })];

    const result = plan({
      contributions,
      rowsInForce: [
        inForce({ '0': { ...FIVE_AND_TWENTY_FIVE, cache_read: 0.5e-6 } }, 'discovery:openai@2026-01-01T00:00:00.000Z'),
      ],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].pricing['0'].cache_read).toBe(0.25e-6);
  });
});
