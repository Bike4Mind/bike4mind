import { describe, expect, it } from 'vitest';
import { evaluatePlatform, evaluateScope, type ScopeObservation, type SpendThresholds } from './rules';

const thresholds: SpendThresholds = {
  platformSpikeRatio: 3,
  platformCriticalRatio: 6,
  platformSpikeFloorCredits: 5000,
  platformCostFloorUsd: 20,
  accountSpikeRatio: 10,
  accountSpikeFloorCredits: 1000,
  accountCeilingCredits: 5000,
  trustedAccountSpikeFloorCredits: 20000,
  trustedAccountCeilingCredits: 40000,
};

const platformCredits = (value: number, baseline: number | null): ScopeObservation => ({
  scopeType: 'platform',
  scopeId: 'all',
  value,
  baseline,
});
const quietCost = platformCredits(0, 0);
const scope = (scopeType: ScopeObservation['scopeType'], value: number, baseline: number | null): ScopeObservation => ({
  scopeType,
  scopeId: 's1',
  value,
  baseline,
});

describe('evaluatePlatform', () => {
  it('warns on a spike above the floor', () => {
    const [breach, ...rest] = evaluatePlatform(platformCredits(15000, 4000), quietCost, thresholds);
    expect(rest).toEqual([]);
    expect(breach).toMatchObject({ rule: 'platform_spike', severity: 'warning', ratio: 3.75 });
  });

  it('is critical at the critical ratio', () => {
    const breaches = evaluatePlatform(platformCredits(30000, 4000), quietCost, thresholds);
    expect(breaches).toHaveLength(1);
    expect(breaches[0].severity).toBe('critical');
  });

  it('ignores a ratio spike below the floor', () => {
    expect(evaluatePlatform(platformCredits(4000, 1000), quietCost, thresholds)).toEqual([]);
  });

  it('fires on absolute size alone without a baseline, as a warning', () => {
    const breaches = evaluatePlatform(platformCredits(15000, null), quietCost, thresholds);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ rule: 'platform_spike', severity: 'warning', ratio: null });
  });

  it('stays quiet without a baseline below floor * ratio', () => {
    expect(evaluatePlatform(platformCredits(14999, null), quietCost, thresholds)).toEqual([]);
  });

  it('evaluates cost against the cost floor', () => {
    const breaches = evaluatePlatform(quietCost, platformCredits(100, 10), thresholds);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ rule: 'platform_cost_spike', severity: 'critical' });
  });

  it('fires a cost spike without a baseline once cost reaches floor * ratio', () => {
    const breaches = evaluatePlatform(quietCost, platformCredits(60, null), thresholds);
    expect(breaches).toEqual([
      expect.objectContaining({ rule: 'platform_cost_spike', severity: 'warning', ratio: null }),
    ]);
    expect(evaluatePlatform(quietCost, platformCredits(59, null), thresholds)).toEqual([]);
  });

  it('returns both breaches when credits and cost spike together', () => {
    const breaches = evaluatePlatform(platformCredits(15000, 4000), platformCredits(100, 10), thresholds);
    expect(breaches.map(breach => breach.rule)).toEqual(['platform_spike', 'platform_cost_spike']);
  });
});

describe('evaluateScope', () => {
  it('raises an account spike warning', () => {
    const breaches = evaluateScope(scope('User', 1200, 100), thresholds);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ rule: 'account_spike', severity: 'warning' });
  });

  it('ignores a spike below the floor', () => {
    expect(evaluateScope(scope('User', 900, 10), thresholds)).toEqual([]);
  });

  it('raises only the ceiling when the ratio is not a spike', () => {
    const breaches = evaluateScope(scope('Organization', 6000, 5000), thresholds);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ rule: 'account_ceiling', severity: 'critical' });
  });

  it('returns both the spike and the ceiling when both fire', () => {
    const rules = evaluateScope(scope('Agent', 6000, 100), thresholds).map(breach => breach.rule);
    expect(rules).toEqual(['account_spike', 'account_ceiling']);
  });

  it('maps apiKey to apikey rules and raises exactly the ceiling for 6000 over a zero baseline', () => {
    const breaches = evaluateScope(scope('apiKey', 6000, 0), thresholds);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ rule: 'apikey_ceiling', severity: 'critical', ratio: null });
  });

  it('raises an apikey spike warning for an apiKey scope', () => {
    const breaches = evaluateScope(scope('apiKey', 1200, 100), thresholds);
    expect(breaches).toEqual([expect.objectContaining({ rule: 'apikey_spike', severity: 'warning', ratio: 12 })]);
  });

  it('returns nothing for platform and model scopes', () => {
    expect(evaluateScope(scope('platform', 99999, 1), thresholds)).toEqual([]);
    expect(evaluateScope(scope('model', 99999, 1), thresholds)).toEqual([]);
  });
});

describe('evaluateScope trusted tier', () => {
  it('stays quiet for a trusted account under its higher ceiling and spike floor', () => {
    // No history (baseline 0): a spike would need floor x ratio, so only the ceiling can fire.
    expect(evaluateScope(scope('User', 30000, 0), thresholds, 'trusted')).toEqual([]);
    // A 10x jump that clears the standard floor but not the trusted one.
    expect(evaluateScope(scope('User', 15000, 1000), thresholds, 'trusted')).toEqual([]);
  });

  it('still warns on a trusted spike above the trusted floor', () => {
    const breaches = evaluateScope(scope('User', 30000, 2000), thresholds, 'trusted');
    expect(breaches.map(b => [b.rule, b.severity])).toEqual([['account_spike', 'warning']]);
  });

  it('still pages a trusted account past its own ceiling, marking the breach trusted', () => {
    const breaches = evaluateScope(scope('User', 40000, 2000), thresholds, 'trusted');
    expect(breaches.map(b => [b.rule, b.severity, b.trusted])).toEqual([
      ['account_spike', 'warning', true],
      ['account_ceiling', 'critical', true],
    ]);
  });

  it('keeps the standard limits for an untrusted account', () => {
    const breaches = evaluateScope(scope('User', 15000, 1000), thresholds);
    expect(breaches.map(b => [b.rule, b.severity])).toEqual([
      ['account_spike', 'warning'],
      ['account_ceiling', 'critical'],
    ]);
    expect(breaches.every(b => b.trusted === undefined)).toBe(true);
  });

  it('applies the trusted limits to API key scopes too', () => {
    expect(evaluateScope(scope('apiKey', 30000, 0), thresholds, 'trusted')).toEqual([]);
    expect(evaluateScope(scope('apiKey', 40000, 0), thresholds, 'trusted').map(b => b.rule)).toContain(
      'apikey_ceiling'
    );
  });
});
