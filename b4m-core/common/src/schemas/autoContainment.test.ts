import { describe, expect, it } from 'vitest';
import { AutoContainmentConfigSchema } from './settings';
import {
  autoContainmentDecisionItemSchema,
  effectiveTierMode,
  isActiveInterventionHold,
  type InterventionHold,
} from './autoContainment';

describe('AutoContainmentConfigSchema tiers', () => {
  it('defaults every graduated tier off and leaves Contain at shadow', () => {
    const config = AutoContainmentConfigSchema.parse({});
    expect(config.mode).toBe('shadow');
    for (const tier of ['limit', 'verify', 'holdGrant', 'review'] as const) {
      expect(config.tiers[tier]).toMatchObject({
        mode: 'off',
        minConfidence: 0.9,
        maxPerHour: 5,
        expiryHours: 72,
        rolloutPercent: 0,
      });
      expect(effectiveTierMode(config, tier)).toBe('off');
    }
    expect(config.tiers.limit.creditsPerHour).toBe(1000);
    expect(effectiveTierMode(config, 'contain')).toBe('shadow');
  });

  it('fills tiers missing from a stored setting', () => {
    const config = AutoContainmentConfigSchema.parse({ mode: 'enforce', tiers: { review: { mode: 'shadow' } } });
    expect(config.tiers.review.mode).toBe('shadow');
    expect(config.tiers.verify.mode).toBe('off');
  });

  it('treats global mode off as the kill switch for every tier', () => {
    const config = AutoContainmentConfigSchema.parse({ mode: 'off', tiers: { limit: { mode: 'enforce' } } });
    expect(effectiveTierMode(config, 'limit')).toBe('off');
    expect(effectiveTierMode(config, 'contain')).toBe('off');
    const on = AutoContainmentConfigSchema.parse({ mode: 'shadow', tiers: { limit: { mode: 'enforce' } } });
    expect(effectiveTierMode(on, 'limit')).toBe('enforce');
  });

  it('turns link rules on by default and keeps an explicit off', () => {
    expect(AutoContainmentConfigSchema.parse({}).linkRules).toEqual({ enabled: true });
    expect(AutoContainmentConfigSchema.parse({ linkRules: { enabled: false } }).linkRules.enabled).toBe(false);
  });

  it('rejects out-of-range tier values', () => {
    expect(() => AutoContainmentConfigSchema.parse({ tiers: { verify: { rolloutPercent: 101 } } })).toThrow();
    expect(() => AutoContainmentConfigSchema.parse({ tiers: { verify: { expiryHours: 0 } } })).toThrow();
    expect(() => AutoContainmentConfigSchema.parse({ tiers: { verify: { minConfidence: 0.4 } } })).toThrow();
  });
});

describe('autoContainmentDecisionItemSchema', () => {
  it('parses a decision recorded before tiers as Contain with no policy version', () => {
    const item = autoContainmentDecisionItemSchema.parse({
      id: 'd1',
      detectionId: 'det',
      revision: 0,
      assessmentId: 'a',
      mode: 'shadow',
      outcome: 'would_contain',
      userIds: ['u'],
      confidence: 0.95,
      reason: 'r',
      batchId: null,
      error: null,
      decidedAt: new Date(),
    });
    expect(item).toMatchObject({ tier: 'contain', policyVersion: null, scope: 'account', expiresAt: null });
    expect(item).toMatchObject({ decidedBy: 'model', linkRules: [], modelJudgment: null });
  });
});

describe('isActiveInterventionHold', () => {
  const now = new Date('2026-11-24T10:00:00Z');
  const hold = (over: Partial<InterventionHold>): InterventionHold => ({
    decisionId: 'd',
    detectionId: 'det',
    tier: 'verify',
    policyVersion: 1,
    reason: 'r',
    appliedAt: now,
    expiresAt: new Date(now.getTime() + 1000),
    releasedAt: null,
    releasedBy: null,
    ...over,
  });

  it('is active only while unreleased and before expiry', () => {
    expect(isActiveInterventionHold(hold({}), now)).toBe(true);
    expect(isActiveInterventionHold(hold({ expiresAt: now }), now)).toBe(false);
    expect(isActiveInterventionHold(hold({ releasedAt: now }), now)).toBe(false);
  });
});
