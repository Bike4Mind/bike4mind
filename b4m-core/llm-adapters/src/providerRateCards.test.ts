/**
 * Adapter price literals against the providers' published rate cards. The literals generate
 * packages/database's modelPrices.seed.json (whose freshness test pins it to them), so a drift
 * caught here is a drift in what every deployment bills.
 */

import { describe, expect, it } from 'vitest';
import { ChatModels, getTextModelCost, getTurnsCost, usdToCredits, type ModelInfo } from '@bike4mind/common';
import { staticPriceBackends } from './adapterPriceLiterals';

/** USD per 1M tokens for prompts above `above` input tokens, up to the next tier's `above`. */
interface RateCardTier {
  above: number;
  input: number;
  output: number;
  cacheRead: number;
  /** Only providers that bill cache writes (Anthropic) list one. */
  cacheWrite?: number;
}

/** UTC day the fixture below was last checked against the provider pages. */
export const RATE_CARDS_CHECKED_ON = '2026-10-19';
const RATE_CARDS_MAX_AGE_DAYS = 60;

// Sources: https://platform.claude.com/docs/en/about-claude/pricing,
// https://developers.openai.com/api/docs/pricing, https://ai.google.dev/gemini-api/docs/pricing and, for
// the us. Bedrock rows (regional endpoints, 10% over global), the AWS price list
// https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/region_index.json.
// gpt-5.6-sol is left out on purpose: its literal carries the regular rate, not the promotion the
// provider page lists (see openaiBackend.ts).
const PROVIDER_RATE_CARDS: Partial<Record<ChatModels, RateCardTier[]>> = {
  [ChatModels.CLAUDE_5_SONNET]: [{ above: 0, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  [ChatModels.CLAUDE_5_SONNET_BEDROCK]: [{ above: 0, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  [ChatModels.CLAUDE_4_5_SONNET]: [{ above: 0, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [ChatModels.CLAUDE_4_5_HAIKU]: [{ above: 0, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  [ChatModels.CLAUDE_4_5_SONNET_BEDROCK]: [{ above: 0, input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 }],
  [ChatModels.CLAUDE_4_5_HAIKU_BEDROCK]: [{ above: 0, input: 1.1, output: 5.5, cacheRead: 0.11, cacheWrite: 1.375 }],
  [ChatModels.GPT5_6_TERRA]: [
    { above: 0, input: 2, output: 12, cacheRead: 0.2 },
    { above: 272_000, input: 4, output: 18, cacheRead: 0.4 },
  ],
  [ChatModels.GPT5_6_LUNA]: [
    { above: 0, input: 0.2, output: 1.2, cacheRead: 0.02 },
    { above: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04 },
  ],
  [ChatModels.GPT5_5]: [
    { above: 0, input: 5, output: 30, cacheRead: 0.5 },
    { above: 272_000, input: 10, output: 45, cacheRead: 1 },
  ],
  [ChatModels.GPT5_4]: [
    { above: 0, input: 2.5, output: 15, cacheRead: 0.25 },
    { above: 272_000, input: 5, output: 22.5, cacheRead: 0.5 },
  ],
  [ChatModels.GEMINI_3_1_PRO_PREVIEW]: [
    { above: 0, input: 2, output: 12, cacheRead: 0.2 },
    { above: 200_000, input: 4, output: 18, cacheRead: 0.4 },
  ],
  [ChatModels.GEMINI_2_5_PRO]: [
    { above: 0, input: 1.25, output: 10, cacheRead: 0.125 },
    { above: 200_000, input: 2.5, output: 15, cacheRead: 0.25 },
  ],
};

const staticTextModels = async (): Promise<Map<string, ModelInfo>> => {
  const models = (await Promise.all(staticPriceBackends().map(backend => backend.getModelInfo()))).flat();
  return new Map(models.filter(model => model.type === 'text').map(model => [String(model.id), model]));
};

const PER_MILLION = 1_000_000;

/** What one 1M-token block of each class bills at, on the tier `promptTokens` selects. */
function billedRates(model: ModelInfo, promptTokens: number) {
  return {
    input: getTextModelCost(model, PER_MILLION, 0, 0, 0, promptTokens),
    output: getTextModelCost(model, 0, PER_MILLION, 0, 0, promptTokens),
    cacheRead: getTextModelCost(model, 0, 0, PER_MILLION, 0, promptTokens),
    cacheWrite: getTextModelCost(model, 0, 0, 0, PER_MILLION, promptTokens),
  };
}

describe('provider rate cards', () => {
  it('reminds to re-verify the rate cards when the check date is old', () => {
    const ageDays = (Date.now() - Date.parse(`${RATE_CARDS_CHECKED_ON}T00:00:00Z`)) / 86_400_000;

    // A reminder, not a failure: asserting on the wall clock would turn every PR red once the date passes.
    if (ageDays > RATE_CARDS_MAX_AGE_DAYS) {
      console.warn(
        `PROVIDER_RATE_CARDS was last checked on ${RATE_CARDS_CHECKED_ON}. Re-verify every rate against the ` +
          'provider pricing pages, fix any drifted adapter literal, then bump RATE_CARDS_CHECKED_ON.'
      );
    }
  });

  it.each(Object.entries(PROVIDER_RATE_CARDS))(
    'every %s price tier matches the provider rate card fixture',
    async (id, tiers) => {
      const model = (await staticTextModels()).get(id);
      if (!model) throw new Error(`${id} has no adapter literal`);

      expect(Object.keys(model.pricing), `${id} tier count`).toHaveLength(tiers.length);
      tiers.forEach((tier, index) => {
        const next = tiers[index + 1];
        // Both edges of the tier: its first token above the lower bound, and its inclusive top.
        const probes = next ? [tier.above + 1, next.above] : [tier.above + 1, model.contextWindow];
        for (const promptTokens of probes) {
          const billed = billedRates(model, promptTokens);
          const label = `${id} at a ${promptTokens}-token prompt`;
          expect(billed.input, `${label}: input`).toBeCloseTo(tier.input, 9);
          expect(billed.output, `${label}: output`).toBeCloseTo(tier.output, 9);
          expect(billed.cacheRead, `${label}: cache read`).toBeCloseTo(tier.cacheRead, 9);
          if (tier.cacheWrite !== undefined) {
            expect(billed.cacheWrite, `${label}: cache write`).toBeCloseTo(tier.cacheWrite, 9);
          }
        }
      });
    }
  );
});

describe('long-context tier selection', () => {
  it('picks the tier per request on its whole prompt, cache reads included', async () => {
    const model = (await staticTextModels()).get(ChatModels.GEMINI_3_1_PRO_PREVIEW)!;

    // 150K uncached + 100K cached is a 250K prompt: the provider bills the >200K tier.
    const longPrompt = getTurnsCost(model, [{ inputTokens: 150_000, cacheReadInputTokens: 100_000, outputTokens: 0 }]);
    expect(longPrompt * PER_MILLION).toBeCloseTo(150_000 * 4 + 100_000 * 0.4, 6);

    // Two 150K requests sum past 200K, but each is priced on its own prompt.
    const twoShortRequests = getTurnsCost(model, [
      { inputTokens: 150_000, outputTokens: 1_000 },
      { inputTokens: 150_000, outputTokens: 1_000 },
    ]);
    expect(twoShortRequests * PER_MILLION).toBeCloseTo(2 * (150_000 * 2 + 1_000 * 12), 6);
  });

  it('bills a prompt exactly at the threshold on the lower tier', async () => {
    const model = (await staticTextModels()).get(ChatModels.GPT5_5)!;

    expect(getTextModelCost(model, 272_000, 0) * PER_MILLION).toBeCloseTo(272_000 * 5, 6);
    expect(getTextModelCost(model, 272_001, 0) * PER_MILLION).toBeCloseTo(272_001 * 10, 6);
  });
});

/** Credits at the documented 1.2 markup / $0.0006 per credit, pinned so an ambient env override cannot move them. */
const CREDITS_PER_USD = 2000;
const credits = (usd: number) => usdToCredits(usd, CREDITS_PER_USD);

describe('billed USD and credits per request', () => {
  it.each([ChatModels.CLAUDE_5_SONNET, ChatModels.CLAUDE_5_SONNET_BEDROCK])(
    'bills %s at $2 / $10 per 1M tokens',
    async id => {
      const model = (await staticTextModels()).get(id)!;

      // 100K in at $2 + 20K out at $10 = $0.20 + $0.20.
      const cost = getTextModelCost(model, 100_000, 20_000);
      expect(cost).toBeCloseTo(0.4, 10);
      expect(credits(cost)).toBe(800);

      // One million tokens of each class: $2, $10, $0.20 cache read, $2.50 cache write.
      expect(credits(getTextModelCost(model, PER_MILLION, 0))).toBe(4_000);
      expect(credits(getTextModelCost(model, 0, PER_MILLION))).toBe(20_000);
      expect(credits(getTextModelCost(model, 0, 0, PER_MILLION, 0))).toBe(400);
      expect(credits(getTextModelCost(model, 0, 0, 0, PER_MILLION))).toBe(5_000);
    }
  );

  it('moves a Gemini 3.1 Pro request to the >200K tier on its whole prompt, cache read included', async () => {
    const model = (await staticTextModels()).get(ChatModels.GEMINI_3_1_PRO_PREVIEW)!;
    const bill = (cacheRead: number) =>
      getTurnsCost(model, [{ inputTokens: 150_000, cacheReadInputTokens: cacheRead, outputTokens: 10_000 }]);

    // 200K prompt: 150K x $2 + 50K x $0.20 + 10K x $12.
    expect(bill(50_000)).toBeCloseTo(0.3 + 0.01 + 0.12, 10);
    expect(credits(bill(50_000))).toBe(860);

    // 200,001 prompt: every class moves up, 150K x $4 + 50,001 x $0.40 + 10K x $18.
    expect(bill(50_001)).toBeCloseTo(0.6 + 0.0200004 + 0.18, 10);
    expect(credits(bill(50_001))).toBe(1_601);
  });

  it('bills the us. Bedrock Haiku 4.5 at the 10% regional premium', async () => {
    const model = (await staticTextModels()).get(ChatModels.CLAUDE_4_5_HAIKU_BEDROCK)!;

    // 100K in at $1.10 + 10K out at $5.50.
    const cost = getTextModelCost(model, 100_000, 10_000);
    expect(cost).toBeCloseTo(0.11 + 0.055, 10);
    expect(credits(cost)).toBe(330);
  });
});
