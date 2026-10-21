import { describe, expect, it } from 'vitest';
import { MAX_USAGE_COUNT } from './activityContract';
import { toReplyUsage, usageTotals } from './replyUsage';

const NONE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  creditsMilli: 0,
};

describe('usageTotals', () => {
  it('maps the server figures onto wire counts, credits in thousandths', () => {
    expect(
      usageTotals({
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadInputTokens: 5000,
        cacheCreationInputTokens: 40,
        creditsUsed: 0.123,
      })
    ).toEqual({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, cacheWriteTokens: 40, creditsMilli: 123 });
  });

  it('reads a missing or unusable figure as zero, and rounds a fractional one', () => {
    expect(usageTotals(undefined)).toEqual(NONE);
    expect(
      usageTotals({ inputTokens: -5, outputTokens: Number.NaN, cacheReadInputTokens: Number.POSITIVE_INFINITY })
    ).toEqual(NONE);
    expect(usageTotals({ inputTokens: 1.4, outputTokens: 1.6 })).toMatchObject({ inputTokens: 1, outputTokens: 2 });
  });

  it('clamps a count to what the wire carries', () => {
    expect(usageTotals({ inputTokens: MAX_USAGE_COUNT + 1, creditsUsed: MAX_USAGE_COUNT })).toEqual({
      ...NONE,
      inputTokens: MAX_USAGE_COUNT,
      creditsMilli: MAX_USAGE_COUNT,
    });
  });
});

describe('toReplyUsage', () => {
  it('reports only what a run added beyond the totals it started with', () => {
    expect(
      toReplyUsage(
        'claude-opus-5',
        usageTotals({ inputTokens: 70_000, creditsUsed: 40 }),
        usageTotals({ inputTokens: 10_000, creditsUsed: 20 })
      )
    ).toEqual({
      model: 'claude-opus-5',
      inputTokens: 60_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      creditsMilli: 20_000,
    });
  });

  it('is null when nothing new was used, or when Fleet cannot key on the model', () => {
    expect(toReplyUsage('claude-opus-5', usageTotals(undefined))).toBeNull();
    expect(
      toReplyUsage('claude-opus-5', usageTotals({ inputTokens: 100 }), usageTotals({ inputTokens: 100 }))
    ).toBeNull();
    expect(toReplyUsage('bad#model', usageTotals({ inputTokens: 100 }))).toBeNull();
    expect(toReplyUsage(null, usageTotals({ inputTokens: 100 }))).toBeNull();
  });
});
