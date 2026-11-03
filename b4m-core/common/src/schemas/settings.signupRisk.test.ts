import { describe, it, expect } from 'vitest';
import { SIGNUP_RISK_SIGNALS, SignupRiskScoringSchema, settingsMap } from './settings';

describe('signupRiskScoring setting', () => {
  const entry = settingsMap.signupRiskScoring;

  it('defaults to a weight for every signal; an unset key fails the parse, so readers fall back to it', () => {
    expect(Object.keys(entry.defaultValue.weights).sort()).toEqual([...SIGNUP_RISK_SIGNALS].sort());
    expect(entry.schema.safeParse(undefined).success).toBe(false);
    expect(SignupRiskScoringSchema.parse({})).toEqual(entry.defaultValue);
  });

  it('fills the rest from the defaults when the stored JSON sets only some values', () => {
    const parsed = entry.schema.parse(JSON.stringify({ weights: { burstCohort: 60 }, reviewThreshold: 70 }));

    expect(parsed).toEqual({
      ...entry.defaultValue,
      weights: { ...entry.defaultValue.weights, burstCohort: 60 },
      reviewThreshold: 70,
    });
  });

  it.each([
    ['a mistyped signal name', { weights: { burstCohrot: 60 } }],
    ['a mistyped top-level field', { reviewTreshold: 80 }],
    ['a weight over 100', { weights: { burstCohort: 101 } }],
    ['a negative weight', { weights: { riskyDomain: -1 } }],
    ['a review threshold of 0, which would flag every account', { reviewThreshold: 0 }],
    ['a fractional quick-key window', { quickApiKeyMinutes: 1.5 }],
    ['a zero fast-spend amount', { fastSpendCredits: 0 }],
  ])('refuses %s', (_label, value) => {
    expect(entry.schema.safeParse(value).success).toBe(false);
  });
});
