import { describe, expect, it } from 'vitest';
import { UsagePatternSignalsConfigSchema, type UsagePatternSignalsConfig } from '@bike4mind/common';
import {
  apiOnlyUsageSignal,
  coefficientOfVariation,
  computeUsagePatternSignals,
  creditPollingSignal,
  quickApiKeySignal,
  regularCadenceSignal,
  type UsagePatternFacts,
} from './usagePatternSignals';

// Sample values for the tests only; real deployments set their own in admin settings.
const config: UsagePatternSignalsConfig = UsagePatternSignalsConfigSchema.parse({
  weights: { apiOnlyUsage: 20, regularCadence: 30, creditPolling: 20, quickApiKey: 30 },
  reviewThreshold: 60,
  apiOnlyMinRequests: 10,
  apiOnlyMinShare: 0.95,
  cadenceSampleSize: 10,
  cadenceMaxVariation: 0.15,
  creditPollMinCount: 10,
  creditPollMinPerCompletion: 1,
  quickApiKeyMinutes: 15,
});

const t0 = Date.UTC(2026, 0, 5, 12, 0, 0);
const minutes = (n: number) => n * 60_000;
const series = (gapsMs: number[]) => {
  const out = [new Date(t0)];
  for (const gap of gapsMs) out.push(new Date(out[out.length - 1].getTime() + gap));
  return out;
};

// Synthetic high-signal account: steady 60s gaps, API-key usage only, a key right after verification.
const highSignalFacts: UsagePatternFacts = {
  apiKeyRequests: 120,
  sessionRequests: 0,
  requestTimes: series(Array.from({ length: 30 }, (_, i) => 60_000 + (i % 3) * 1000)),
  creditPolls: 150,
  completions: 120,
  emailVerifiedAt: new Date(t0),
  firstApiKeyAt: new Date(t0 + minutes(3)),
};

// Synthetic: mostly web usage at irregular times, an occasional balance check, a key days later.
const typicalFacts: UsagePatternFacts = {
  apiKeyRequests: 4,
  sessionRequests: 60,
  requestTimes: series([
    30_000,
    minutes(12),
    90_000,
    minutes(240),
    20_000,
    minutes(45),
    minutes(5),
    600_000,
    45_000,
    minutes(900),
    70_000,
  ]),
  creditPolls: 2,
  completions: 64,
  emailVerifiedAt: new Date(t0),
  firstApiKeyAt: new Date(t0 + minutes(60 * 24 * 4)),
};

describe('coefficientOfVariation', () => {
  it('is 0 for constant values and null for none', () => {
    expect(coefficientOfVariation([5, 5, 5])).toBe(0);
    expect(coefficientOfVariation([0, 0])).toBe(0);
    expect(coefficientOfVariation([])).toBeNull();
  });

  it('is stddev over mean', () => {
    expect(coefficientOfVariation([1, 3])).toBeCloseTo(0.5);
  });
});

describe('apiOnlyUsageSignal', () => {
  it('triggers when enough usage is all through API keys', () => {
    const s = apiOnlyUsageSignal({ apiKeyRequests: 10, sessionRequests: 0 }, config);
    expect(s).toMatchObject({ id: 'apiOnlyUsage', value: 1, triggered: true, weight: 20 });
    expect(s.explanation).toBe(
      'All 10 completions in the last 30 days were made with an API key, none from a signed-in session'
    );
  });

  it('does not trigger below the minimum request count', () => {
    expect(apiOnlyUsageSignal({ apiKeyRequests: 9, sessionRequests: 0 }, config).triggered).toBe(false);
  });

  it('does not trigger below the minimum API share', () => {
    const s = apiOnlyUsageSignal({ apiKeyRequests: 90, sessionRequests: 10 }, config);
    expect(s).toMatchObject({ value: 0.9, triggered: false });
    expect(s.explanation).toBe('90% of 100 completions in the last 30 days were made with an API key');
  });

  it('reports no value without usage', () => {
    expect(apiOnlyUsageSignal({ apiKeyRequests: 0, sessionRequests: 0 }, config)).toMatchObject({
      value: null,
      triggered: false,
    });
  });
});

describe('regularCadenceSignal', () => {
  it('triggers on evenly spaced requests', () => {
    const s = regularCadenceSignal(series(Array(9).fill(60_000)), config);
    expect(s).toMatchObject({ id: 'regularCadence', value: 0, triggered: true });
    expect(s.explanation).toBe('Gaps between the last 10 requests average 1m and vary by 0%');
  });

  it('does not trigger on irregular requests', () => {
    expect(regularCadenceSignal(typicalFacts.requestTimes, config).triggered).toBe(false);
  });

  it('measures only the most recent sample, in time order', () => {
    const irregularThenSteady = [
      ...series([minutes(400), 5000, minutes(90)]),
      ...series(Array(9).fill(30_000)).map(d => new Date(d.getTime() + minutes(1000))),
    ].reverse();
    expect(regularCadenceSignal(irregularThenSteady, config)).toMatchObject({ value: 0, triggered: true });
  });

  it('needs a full sample', () => {
    const s = regularCadenceSignal(series(Array(8).fill(60_000)), config);
    expect(s).toMatchObject({ value: null, triggered: false });
    expect(s.explanation).toBe('9 recent requests, too few to measure request timing');
  });
});

describe('creditPollingSignal', () => {
  it('triggers when balance checks reach the per-completion ratio', () => {
    expect(creditPollingSignal({ creditPolls: 20, completions: 10 }, config)).toMatchObject({
      value: 2,
      triggered: true,
      explanation: '20 credit balance checks and 10 completions in the last 7 days',
    });
  });

  it('counts polling with no completions against one completion', () => {
    expect(creditPollingSignal({ creditPolls: 12, completions: 0 }, config)).toMatchObject({
      value: 12,
      triggered: true,
    });
  });

  it('does not trigger below the minimum poll count or ratio', () => {
    expect(creditPollingSignal({ creditPolls: 9, completions: 1 }, config).triggered).toBe(false);
    expect(creditPollingSignal({ creditPolls: 10, completions: 40 }, config).triggered).toBe(false);
  });
});

describe('quickApiKeySignal', () => {
  it('triggers at the boundary minute', () => {
    const s = quickApiKeySignal({ emailVerifiedAt: new Date(t0), firstApiKeyAt: new Date(t0 + minutes(15)) }, config);
    expect(s).toMatchObject({ value: 15, triggered: true });
    expect(s.explanation).toBe('First API key created 15 minutes after email verification');
  });

  it('does not trigger after the window', () => {
    expect(
      quickApiKeySignal({ emailVerifiedAt: new Date(t0), firstApiKeyAt: new Date(t0 + minutes(16)) }, config).triggered
    ).toBe(false);
  });

  it('triggers for a key created shortly before verification', () => {
    const s = quickApiKeySignal({ emailVerifiedAt: new Date(t0), firstApiKeyAt: new Date(t0 - minutes(5)) }, config);
    expect(s).toMatchObject({
      triggered: true,
      explanation: 'First API key created 5 minutes before email verification',
    });
  });

  it('does not trigger for a key created long before a late verification', () => {
    const lateVerification = { emailVerifiedAt: new Date(t0), firstApiKeyAt: new Date(t0 - minutes(60 * 24 * 2)) };
    expect(quickApiKeySignal(lateVerification, config).triggered).toBe(false);
  });

  it('reports no value without a key or a verification time', () => {
    expect(quickApiKeySignal({ emailVerifiedAt: new Date(t0), firstApiKeyAt: null }, config)).toMatchObject({
      value: null,
      triggered: false,
    });
    expect(quickApiKeySignal({ emailVerifiedAt: null, firstApiKeyAt: new Date(t0) }, config)).toMatchObject({
      value: null,
      triggered: false,
    });
  });
});

describe('computeUsagePatternSignals', () => {
  it('scores a high-signal synthetic account above the review threshold', () => {
    const result = computeUsagePatternSignals(highSignalFacts, config);
    expect(result.signals.map(s => [s.id, s.triggered])).toEqual([
      ['apiOnlyUsage', true],
      ['regularCadence', true],
      ['creditPolling', true],
      ['quickApiKey', true],
    ]);
    expect(result).toMatchObject({ score: 100, needsReview: true });
  });

  it('keeps a typical synthetic account below the review threshold', () => {
    const result = computeUsagePatternSignals(typicalFacts, config);
    expect(result.signals.every(s => !s.triggered)).toBe(true);
    expect(result).toMatchObject({ score: 0, needsReview: false });
  });

  it('adds nothing for a zero-weight signal and caps the score at 100', () => {
    const zeroed = UsagePatternSignalsConfigSchema.parse({
      ...config,
      weights: { ...config.weights, quickApiKey: 0 },
    });
    const result = computeUsagePatternSignals(highSignalFacts, zeroed);
    expect(result.signals.find(s => s.id === 'quickApiKey')).toMatchObject({ triggered: true, weight: 0 });
    expect(result.score).toBe(70);

    const capped = UsagePatternSignalsConfigSchema.parse({
      ...config,
      weights: { ...config.weights, apiOnlyUsage: 100 },
    });
    expect(computeUsagePatternSignals(highSignalFacts, capped).score).toBe(100);
  });
});

describe('UsagePatternSignalsConfigSchema', () => {
  it('fills generic defaults from an empty object', () => {
    const parsed = UsagePatternSignalsConfigSchema.parse({});
    expect(parsed.weights).toEqual({ apiOnlyUsage: 25, regularCadence: 25, creditPolling: 25, quickApiKey: 25 });
    expect(parsed.reviewThreshold).toBe(50);
  });

  it('ignores unknown fields so tuned values survive a renamed field', () => {
    const parsed = UsagePatternSignalsConfigSchema.parse({
      reviewThreshold: 70,
      weights: { apiOnly: 10 },
      oldField: 1,
    });
    expect(parsed.reviewThreshold).toBe(70);
    expect(parsed.weights).not.toHaveProperty('apiOnly');
    expect(parsed).not.toHaveProperty('oldField');
  });

  it('refuses out-of-range values', () => {
    expect(UsagePatternSignalsConfigSchema.safeParse({ reviewThreshold: 0 }).success).toBe(false);
    expect(UsagePatternSignalsConfigSchema.safeParse({ apiOnlyMinShare: 1.5 }).success).toBe(false);
  });
});
