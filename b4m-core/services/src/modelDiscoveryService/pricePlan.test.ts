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
/** A third mirror; the repo registers two, and some rules only show up past that. */
const openRouter = (price: DiscoveredPrice, modelId?: string) =>
  from('openrouter', 'aggregator', priced(price, modelId));

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

/**
 * A stored pricing map read back in $/MTok, which is the unit the sources quote
 * and the one these expectations are legible in. Rounded like the run report's
 * own numbers: a rate that crosses 1e6 and back picks up float noise
 * (0.2 -> 2.0000000000000002e-7), and that noise is not what any of these
 * assertions are about.
 */
const perMTok = (pricing: Record<string, IModelPriceTier>): Record<string, Record<string, number>> =>
  Object.fromEntries(
    Object.entries(pricing).map(([threshold, tier]) => [
      threshold,
      Object.fromEntries(Object.entries(tier).map(([rate, value]) => [rate, Number((value * 1e6).toPrecision(10))])),
    ])
  );

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

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('never writes a %s rate, whoever reported it', (_label, rate) => {
    const result = plan({
      contributions: [provider({ inputPerMTok: rate, outputPerMTok: 25 })],
      rowsInForce: [],
    });

    expect(result.rows).toEqual([]);
  });

  it('proposes one of the two values it names as disagreeing', () => {
    // Three aggregators where the outer two disagree with each other and the
    // middle one agrees with both, so the first disagreeing pair excludes it.
    const result = plan({
      contributions: [
        openRouter({ inputPerMTok: 5, outputPerMTok: 25 }),
        modelsDev({ inputPerMTok: 4.6, outputPerMTok: 25 }),
        litellm({ inputPerMTok: 5.4, outputPerMTok: 25 }),
      ],
    });

    expect(result.flags[0]).toMatchObject({ kind: 'source-disagreement' });
    // A proposed value from neither side of the detail line is a number the
    // operator cannot find in the sentence explaining it.
    expect(result.flags[0].proposed.inputPerMTok).toBe(4.6);
    expect(result.flags[0].detail).toContain('models.dev');
    expect(result.flags[0].detail).toContain('litellm');
  });

  it('applies neither side when the only aggregator disagrees with the provider', () => {
    const result = plan({
      contributions: [
        modelsDev({ inputPerMTok: 5, outputPerMTok: 25 }),
        provider({ inputPerMTok: 15, outputPerMTok: 25 }),
      ],
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0].kind).toBe('source-disagreement');
    // A different sentence from mirrors contradicting each other: what is wrong
    // here is that nothing backs the provider up.
    expect(result.flags[0].detail).toContain('no source corroborates the provider');
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
    // The band is the ratio between the two rates, so 200% passes anything up to
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
    const result = plan({
      contributions: [provider({ inputPerMTok: 50, outputPerMTok: 25 })],
      rowsInForce: [inForce({ '0': FIVE_AND_TWENTY_FIVE })],
      bandPct: 200,
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'band-exceeded', proposed: { inputPerMTok: 50 } });
  });

  it('scores a 5x cut as 400%, the same multiple as the matching rise', () => {
    // $1/MTok down to $0.20 is the shape a provider price drop actually arrives
    // in. Measured as a fraction of the rate in force it would score 80% and no
    // band of 100 or more could ever flag a cut at all.
    const banded = (bandPct: number) =>
      plan({
        contributions: [provider({ inputPerMTok: 0.2, outputPerMTok: 25 })],
        rowsInForce: [inForce({ '0': { input: 1e-6, output: 25e-6 } })],
        bandPct,
      });

    const flagged = banded(50);
    expect(flagged.rows).toEqual([]);
    expect(flagged.flags[0]).toMatchObject({ kind: 'band-exceeded', proposed: { inputPerMTok: 0.2 } });
    expect(flagged.flags[0].detail).toContain('input 400%');

    // 500 is the setting's cap, and 400% is inside it.
    const wide = banded(500);
    expect(wide.flags).toEqual([]);
    expect(wide.rows).toHaveLength(1);
  });

  it.each([
    ['rise', 18],
    ['cut', 2],
  ])('passes a 3x %s at a band of 200 and flags it at 150', (_label, observed) => {
    const banded = (bandPct: number) =>
      plan({
        contributions: [provider({ inputPerMTok: observed, outputPerMTok: 25 })],
        rowsInForce: [inForce({ '0': { input: 6e-6, output: 25e-6 } })],
        bandPct,
      });

    // What the setting's own description promises: 200 passes up to a 3x change
    // in EITHER direction, and both directions score the same 200%.
    expect(banded(200).flags).toEqual([]);
    expect(banded(200).rows).toHaveLength(1);

    const tight = banded(150);
    expect(tight.rows).toEqual([]);
    expect(tight.flags[0]).toMatchObject({ kind: 'band-exceeded' });
    expect(tight.flags[0].detail).toContain('input 200%');
  });

  it('reads a move off a zero rate as unbounded, which no band passes', () => {
    const result = plan({
      contributions: [provider({ inputPerMTok: 5, outputPerMTok: 25 })],
      rowsInForce: [inForce({ '0': { input: 0, output: 25e-6 } })],
      bandPct: 500,
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'band-exceeded' });
    expect(result.flags[0].detail).toContain('input unbounded');
  });

  it('fails the band closed when the row it bands against carries an unusable rate', () => {
    // The discovered side cannot reach this (isUsable requires a finite rate), so
    // this is the stored side. NaN > band is false, which would wave the move
    // through as if it were inside the band.
    const result = plan({
      contributions: [provider({ inputPerMTok: 5, outputPerMTok: 25 })],
      rowsInForce: [inForce({ '0': { input: Number.NaN, output: 25e-6 } })],
      bandPct: 500,
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'band-exceeded' });
    expect(result.flags[0].detail).toContain('input unbounded');
  });

  it('measures the band against the run-start row, not the one an earlier pass wrote', () => {
    // Pass 2 of a run: $5 was in force when the run started, pass 1 wrote $7
    // (40%, inside the band), and the feed has drifted to $9.8 - another 40%
    // against pass 1's row, but 96% against where the run began.
    const result = plan({
      contributions: [provider({ inputPerMTok: 9.8, outputPerMTok: 25 })],
      rowsInForce: [inForce({ '0': { input: 7e-6, output: 25e-6 } }, 'discovery:openai@2026-07-26T10:00:00.000Z')],
      baselineRowsInForce: [inForce({ '0': FIVE_AND_TWENTY_FIVE })],
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'band-exceeded', proposed: { inputPerMTok: 9.8 } });
    expect(result.flags[0].detail).toContain('run start');
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

    expect(result).toEqual({ rows: [], flags: [], overrides: [], skipped: [] });
  });
});

/**
 * A provider's own published price is primary: it needs ONE mirror to agree, not
 * all of them. The mirrors go stale on their own schedules (litellm publishes off
 * a git ref, models.dev re-scrapes on its own cadence), so a unanimity rule hands
 * any one of them a veto over a price the provider itself publishes.
 */
describe('planPriceWrites provider primacy', () => {
  const CUT: DiscoveredPrice = { inputPerMTok: 0.2, outputPerMTok: 1.2 };
  const STALE: DiscoveredPrice = { inputPerMTok: 1, outputPerMTok: 6 };
  const CUT_IN_FORCE: IModelPriceTier = { input: 1e-6, output: 6e-6 };

  it('writes the provider price when one mirror agrees and another is stale', () => {
    const result = plan({
      contributions: [provider(CUT), modelsDev(CUT), litellm(STALE)],
      rowsInForce: [inForce({ '0': CUT_IN_FORCE })],
      bandPct: 500,
    });

    expect(result.flags).toEqual([]);
    expect(perMTok(result.rows[0].pricing)).toEqual({ '0': { input: 0.2, output: 1.2 } });
    // Credited to the provider alone: the agreeing mirror corroborated the value,
    // it did not supply it.
    expect(result.rows[0].note).toBe(`discovery:openai@${RUN_AT.toISOString()}`);
  });

  it('records the overruled source rather than swallowing it', () => {
    const result = plan({
      contributions: [provider(CUT), modelsDev(CUT), litellm(STALE)],
      rowsInForce: [inForce({ '0': CUT_IN_FORCE })],
      bandPct: 500,
    });

    expect(result.overrides).toHaveLength(1);
    expect(result.overrides[0]).toMatchObject({
      modelId: 'gpt-6',
      source: 'openai',
      dissenting: ['litellm'],
      applied: { inputPerMTok: 0.2, outputPerMTok: 1.2 },
    });
    // The whole point of recording it: the operator learns WHICH mirror is stale.
    expect(result.overrides[0].detail).toContain('litellm');
    expect(result.overrides[0].detail).toContain('in 1/out 6');
  });

  it('records nothing when every source agreed', () => {
    const result = plan({ contributions: [provider(CUT), modelsDev(CUT), litellm(CUT)] });

    expect(result.rows).toHaveLength(1);
    expect(result.overrides).toEqual([]);
  });

  it('writes the provider price when the mirrors disagree with each other but not with it', () => {
    const result = plan({
      contributions: [
        provider({ inputPerMTok: 5, outputPerMTok: 25 }),
        modelsDev({ inputPerMTok: 4.6, outputPerMTok: 25 }),
        litellm({ inputPerMTok: 5.4, outputPerMTok: 25 }),
      ],
    });

    expect(result.flags).toEqual([]);
    expect(result.rows[0].pricing['0'].input).toBe(5e-6);
    expect(result.overrides).toEqual([]);
  });

  it('refuses when every mirror disagrees with the provider', () => {
    // Primary, not unaccountable. All of them dissenting is the shape of a parser
    // that broke against a docs restructure, which must reprice nothing.
    const result = plan({
      contributions: [provider(CUT), modelsDev(STALE), litellm(STALE)],
      rowsInForce: [inForce({ '0': CUT_IN_FORCE })],
      bandPct: 500,
    });

    expect(result.rows).toEqual([]);
    expect(result.overrides).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'source-disagreement' });
  });

  it('still writes a provider price no mirror carries at all', () => {
    const result = plan({ contributions: [provider(CUT)] });

    expect(result.rows).toHaveLength(1);
    expect(result.overrides).toEqual([]);
  });

  it('does not record an override for a price it declined to write', () => {
    // The band refuses this move, so nothing was applied over anything.
    const result = plan({
      contributions: [provider(CUT), modelsDev(CUT), litellm(STALE)],
      rowsInForce: [inForce({ '0': CUT_IN_FORCE })],
      bandPct: 50,
    });

    expect(result.rows).toEqual([]);
    expect(result.overrides).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'band-exceeded' });
  });

  it('leaves the aggregator-only rules exactly as they were', () => {
    const disagreeing = plan({
      contributions: [
        modelsDev({ inputPerMTok: 5, outputPerMTok: 25 }),
        litellm({ inputPerMTok: 9, outputPerMTok: 25 }),
      ],
    });
    expect(disagreeing.rows).toEqual([]);
    expect(disagreeing.flags[0]).toMatchObject({ kind: 'source-disagreement' });

    const lone = plan({ contributions: [litellm({ inputPerMTok: 5, outputPerMTok: 25 })] });
    expect(lone.rows).toEqual([]);
    expect(lone.flags[0]).toMatchObject({ kind: 'single-source-untrusted' });
  });

  it('makes two providers that disagree with each other refuse, with neither outranking', () => {
    const result = plan({
      contributions: [
        provider({ inputPerMTok: 5, outputPerMTok: 25 }),
        from('bedrock', 'provider', priced({ inputPerMTok: 15, outputPerMTok: 25 })),
        modelsDev({ inputPerMTok: 5, outputPerMTok: 25 }),
      ],
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'source-disagreement' });
    // Two providers is a mutual contradiction, not an uncorroborated one, even
    // though both sides of the pair are providers.
    expect(result.flags[0].detail).toContain('sources disagree beyond');
    expect(result.flags[0].detail).not.toContain('corroborates');
  });

  it('lets a provider ladder reprice a tiered row over a stale flat mirror', () => {
    // The case this whole change exists for: the provider publishes the ladder,
    // one mirror agrees, and the other still has last quarter's price.
    const ladder: DiscoveredPrice = {
      inputPerMTok: 0.2,
      outputPerMTok: 1.2,
      brackets: [{ aboveTokens: 272_000, inputPerMTok: 0.4, outputPerMTok: 1.8 }],
    };
    const result = plan({
      contributions: [provider(ladder), modelsDev(ladder), litellm(STALE)],
      rowsInForce: [inForce({ '272000': { input: 1e-6, output: 6e-6 }, '1050000': { input: 2e-6, output: 9e-6 } })],
      bandPct: 500,
    });

    expect(result.flags).toEqual([]);
    expect(perMTok(result.rows[0].pricing)).toEqual({
      '272000': { input: 0.2, output: 1.2 },
      '1050000': { input: 0.4, output: 1.8 },
    });
    expect(result.overrides[0].dissenting).toEqual(['litellm']);
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

describe('planPriceWrites tier ladders', () => {
  const LUNA = 'gpt-5.6-luna';

  /**
   * The row in force as production holds it: a two-tier ladder whose keys are the
   * UPPER bound of each bracket (tierForTokens picks the first threshold >= the
   * prompt), so 272000 is the up-to-272k rate and 1050000 the rest of the window.
   */
  const LUNA_ROW: Record<string, IModelPriceTier> = {
    '272000': { input: 1e-6, output: 6e-6 },
    '1050000': { input: 2e-6, output: 9e-6 },
  };

  /** models.dev after the 80% cut: a base rate plus one bracket above 272k. */
  const LUNA_MODELS_DEV: DiscoveredPrice = {
    inputPerMTok: 0.2,
    outputPerMTok: 1.2,
    cacheReadPerMTok: 0.02,
    cacheWritePerMTok: 0.25,
    brackets: [
      {
        aboveTokens: 272_000,
        inputPerMTok: 0.4,
        outputPerMTok: 1.8,
        cacheReadPerMTok: 0.04,
        cacheWritePerMTok: 0.5,
      },
    ],
  };

  /** The same rates off litellm, whose per-token quotes pick up 1e6 float noise. */
  const LUNA_LITELLM: DiscoveredPrice = {
    inputPerMTok: 2e-7 * 1e6,
    outputPerMTok: 1.2e-6 * 1e6,
    cacheReadPerMTok: 2e-8 * 1e6,
    cacheWritePerMTok: 2.5e-7 * 1e6,
    brackets: [
      {
        aboveTokens: 272_000,
        inputPerMTok: 4e-7 * 1e6,
        outputPerMTok: 1.8e-6 * 1e6,
        cacheReadPerMTok: 4e-8 * 1e6,
        cacheWritePerMTok: 5e-7 * 1e6,
      },
    ],
  };

  const lunaPlan = (overrides: Partial<PricePlanInput> = {}) =>
    plan({
      knownModelIds: new Set([LUNA]),
      rowsInForce: [inForce(LUNA_ROW, 'adapter-seed', LUNA)],
      // An 80% cut is a 5x move, so the default 50% band would flag it. The band
      // is a separate guardrail and has its own cases below.
      bandPct: 500,
      ...overrides,
    });

  it('rewrites both tiers of the row in force from the brackets both aggregators publish', () => {
    const result = lunaPlan({
      contributions: [modelsDev(LUNA_MODELS_DEV, LUNA), litellm(LUNA_LITELLM, LUNA)],
    });

    expect(result.flags).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.rows).toHaveLength(1);
    // The keys are the row's own, untouched: re-deriving a threshold would move
    // where the long-context rate starts.
    expect(Object.keys(result.rows[0].pricing)).toEqual(['272000', '1050000']);
    expect(perMTok(result.rows[0].pricing)).toEqual({
      '272000': { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 },
      '1050000': { input: 0.4, output: 1.8, cache_read: 0.04, cache_write: 0.5 },
    });
    // Stored per SINGLE token, the same 1e6 crossing a flat row makes.
    expect(result.rows[0].pricing['1050000'].input).toBeLessThan(1e-6);
    expect(result.rows[0].note).toBe(`discovery:models.dev+litellm@${RUN_AT.toISOString()}`);
    expect(result.rows[0].repricedBy).toBe('model-discovery');
  });

  it('applies neither side when the two sources agree on the base and differ on the bracket', () => {
    const disagreeing: DiscoveredPrice = {
      ...LUNA_MODELS_DEV,
      brackets: [{ aboveTokens: 272_000, inputPerMTok: 0.9, outputPerMTok: 1.8 }],
    };
    const result = lunaPlan({ contributions: [modelsDev(LUNA_MODELS_DEV, LUNA), litellm(disagreeing, LUNA)] });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'source-disagreement', sources: ['models.dev', 'litellm'] });
    // Both upper rates on the line: the base rates are identical, so a detail
    // without the brackets would show two equal prices "disagreeing".
    expect(result.flags[0].detail).toContain('above 272000 in 0.4');
    expect(result.flags[0].detail).toContain('above 272000 in 0.9');
  });

  it('applies neither side when only one source publishes a breakpoint the other does not', () => {
    const shifted: DiscoveredPrice = {
      ...LUNA_MODELS_DEV,
      brackets: [{ aboveTokens: 200_000, inputPerMTok: 0.4, outputPerMTok: 1.8 }],
    };
    const result = lunaPlan({ contributions: [modelsDev(LUNA_MODELS_DEV, LUNA), litellm(shifted, LUNA)] });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'source-disagreement' });
  });

  it('still refuses a ladder whose breakpoints do not line up with the row', () => {
    const misaligned: DiscoveredPrice = {
      ...LUNA_MODELS_DEV,
      brackets: [{ aboveTokens: 200_000, inputPerMTok: 0.4, outputPerMTok: 1.8 }],
    };
    const result = lunaPlan({ contributions: [modelsDev(misaligned, LUNA), litellm(misaligned, LUNA)] });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'tiered-pricing-manual' });
    // The flag has to say WHY it could not be mapped, not only that it wasn't.
    expect(result.flags[0].detail).toContain('272000, 1050000');
    expect(result.flags[0].detail).toContain('brackets above 200000 do not line up');
  });

  it('still refuses a flat observation against a tiered row, and says so', () => {
    const flat: DiscoveredPrice = { inputPerMTok: 0.2, outputPerMTok: 1.2 };
    const result = lunaPlan({ contributions: [modelsDev(flat, LUNA), litellm(flat, LUNA)] });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'tiered-pricing-manual' });
    expect(result.flags[0].detail).toContain('the sources publish one flat rate');
  });

  it('flags the ladder when only its upper tier leaves the band', () => {
    // The base rate barely moves and the 1050000 tier goes up 10x. Banding on the
    // lowest tier alone would write that upper rate unattended.
    const runaway: DiscoveredPrice = {
      inputPerMTok: 1.02,
      outputPerMTok: 6,
      brackets: [{ aboveTokens: 272_000, inputPerMTok: 20, outputPerMTok: 9 }],
    };
    const result = lunaPlan({
      contributions: [modelsDev(runaway, LUNA), litellm(runaway, LUNA)],
      bandPct: 200,
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'band-exceeded' });
    // Named per tier, or 'input' alone would not say which rung moved.
    expect(result.flags[0].detail).toContain('input@1050000 900%');
    expect(result.flags[0].detail).toContain('above 272000 in 2');
  });

  it.each([
    ['carries an unusable rate', [{ aboveTokens: 272_000, inputPerMTok: Number.NaN, outputPerMTok: 1.8 }]],
    ['is free above the breakpoint', [{ aboveTokens: 272_000, inputPerMTok: 0, outputPerMTok: 0 }]],
    [
      'quotes one breakpoint twice',
      [
        { aboveTokens: 272_000, inputPerMTok: 0.4, outputPerMTok: 1.8 },
        { aboveTokens: 272_000, inputPerMTok: 0.9, outputPerMTok: 1.8 },
      ],
    ],
  ])('refuses the whole ladder when a bracket %s', (_label, brackets) => {
    const broken: DiscoveredPrice = { ...LUNA_MODELS_DEV, brackets };
    const result = lunaPlan({ contributions: [modelsDev(broken, LUNA), litellm(broken, LUNA)] });

    // A ladder we cannot read is a flat observation, which a tiered row refuses.
    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'tiered-pricing-manual' });
    expect(result.flags[0].detail).toContain('the sources publish one flat rate');
  });

  it('appends nothing when the same ladder is observed again', () => {
    const contributions = [modelsDev(LUNA_MODELS_DEV, LUNA), litellm(LUNA_LITELLM, LUNA)];
    const first = lunaPlan({ contributions });

    const second = lunaPlan({
      contributions,
      rowsInForce: [
        {
          ...inForce(LUNA_ROW, `discovery:models.dev+litellm@${RUN_AT.toISOString()}`, LUNA),
          pricing: first.rows[0].pricing,
        },
      ],
    });

    expect(second.rows).toEqual([]);
    expect(second.flags).toEqual([]);
    expect(second.skipped).toEqual([{ modelId: LUNA, reason: 'unchanged' }]);
  });

  it('carries a cache rate forward per tier, from the tier under the same threshold', () => {
    // grok-4.5's shape: a 200k breakpoint with cache_read in both tiers, and an
    // audio rate no feed publishes that only survives by being carried.
    const GROK = 'grok-4.5';
    const observed: DiscoveredPrice = {
      inputPerMTok: 2.2,
      outputPerMTok: 6,
      cacheReadPerMTok: 0.33,
      brackets: [{ aboveTokens: 200_000, inputPerMTok: 4.4, outputPerMTok: 12 }],
    };
    const result = plan({
      knownModelIds: new Set([GROK]),
      contributions: [modelsDev(observed, GROK), litellm(observed, GROK)],
      rowsInForce: [
        inForce(
          {
            '200000': { input: 2e-6, output: 6e-6, cache_read: 0.3e-6, audio_input: 40e-6 },
            '500000': { input: 4e-6, output: 12e-6, cache_read: 0.6e-6 },
          },
          'adapter-seed',
          GROK
        ),
      ],
    });

    expect(result.flags).toEqual([]);
    expect(perMTok(result.rows[0].pricing)).toEqual({
      // The observed cache rate wins in the tier that quotes one; the upper tier
      // keeps its own 0.6 rather than inheriting the base tier's.
      '200000': { input: 2.2, output: 6, cache_read: 0.33, audio_input: 40 },
      '500000': { input: 4.4, output: 12, cache_read: 0.6 },
    });
  });

  it('leaves a flat row flat even when the sources publish a ladder', () => {
    const result = plan({
      contributions: [
        provider({ inputPerMTok: 6, outputPerMTok: 25 }),
        modelsDev({
          inputPerMTok: 6,
          outputPerMTok: 25,
          brackets: [{ aboveTokens: 200_000, inputPerMTok: 12, outputPerMTok: 50 }],
        }),
      ],
      rowsInForce: [inForce({ '1000000': FIVE_AND_TWENTY_FIVE })],
    });

    // Inventing a second threshold would bill long prompts at a rate that was
    // never in a row, so the base rate lands alone under the row's own key.
    expect(result.rows[0].pricing).toEqual({ '1000000': { input: 6e-6, output: 25e-6 } });
  });

  it('refuses the ladder when the run-start row has no tier to band the upper one against', () => {
    // Pass 2 of a run whose pass 1 wrote a differently keyed row: the upper tier
    // would go in unbanded, which is the one thing the band exists to prevent.
    const result = lunaPlan({
      contributions: [modelsDev(LUNA_MODELS_DEV, LUNA), litellm(LUNA_LITELLM, LUNA)],
      baselineRowsInForce: [inForce({ '272000': { input: 1e-6, output: 6e-6 } }, 'adapter-seed', LUNA)],
    });

    expect(result.rows).toEqual([]);
    expect(result.flags[0]).toMatchObject({ kind: 'tiered-pricing-manual' });
    expect(result.flags[0].detail).toContain('no tier at 1050000');
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
    // The cache rates here are a fifth apart on purpose: halving one is a 100%
    // move against the band, and these carry-forward cases are not about the band.
    const result = plan({
      contributions: [provider({ inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.25, cacheWritePerMTok: 5 })],
      rowsInForce: [
        inForce(
          { '0': { ...FIVE_AND_TWENTY_FIVE, cache_read: 0.3e-6, cache_write: 6.25e-6 } },
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
    // The text rates are identical, so a detail that only printed input and
    // output would show two equal prices "disagreeing" - the flag is only
    // explainable if the cache rate that actually differs is on the line.
    expect(result.flags[0].detail).toContain('cache_read 0.3');
    expect(result.flags[0].detail).toContain('cache_read 0.5');
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
          { '0': { ...FIVE_AND_TWENTY_FIVE, cache_read: 0.3e-6, cache_write: 6.25e-6 } },
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
        inForce({ '0': { ...FIVE_AND_TWENTY_FIVE, cache_read: 0.3e-6 } }, 'discovery:openai@2026-01-01T00:00:00.000Z'),
      ],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].pricing['0'].cache_read).toBe(0.25e-6);
  });
});
