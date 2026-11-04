import type { SpendAlertSeverity, SpendRollupScopeType, SpendRuleId } from '@bike4mind/common';

export type SpendThresholds = {
  platformSpikeRatio: number;
  platformCriticalRatio: number;
  platformSpikeFloorCredits: number;
  platformCostFloorUsd: number;
  accountSpikeRatio: number;
  accountSpikeFloorCredits: number;
  accountCeilingCredits: number;
  /** Replace the account floor and ceiling for scopes resolved as trusted (see trust.ts). */
  trustedAccountSpikeFloorCredits: number;
  trustedAccountCeilingCredits: number;
};

export type AccountTier = 'standard' | 'trusted';

export type SpendBreach = {
  rule: SpendRuleId;
  scopeType: SpendRollupScopeType;
  scopeId: string;
  severity: SpendAlertSeverity;
  value: number;
  baseline: number | null;
  ratio: number | null;
  /** Set on account-level breaches of a trusted scope. */
  trusted?: true;
  /** Platform breaches only: the part of `value` spent by trusted accounts, left out of the ratio and floors. */
  trustedExcluded?: number;
  /** Names of API keys whose own breach was folded into this payer's. */
  viaKeys?: string[];
};

/**
 * A platform metric for one window. `value` and `baseline` are standard-tier spend, which the floors
 * and the ratio are judged on; `total` is what the window really spent, which the alert reports.
 */
export type PlatformObservation = ScopeObservation & { total: number };

export type ScopeObservation = {
  scopeType: SpendRollupScopeType;
  scopeId: string;
  value: number;
  baseline: number | null;
};

function ratioOf(obs: ScopeObservation): number | null {
  return obs.baseline !== null && obs.baseline > 0 ? obs.value / obs.baseline : null;
}

// With no baseline (cold start or idle scope) only a large absolute amount counts as a spike.
function isSpike(obs: ScopeObservation, ratio: number | null, spikeRatio: number, floor: number): boolean {
  if (ratio === null) return obs.value >= floor * spikeRatio;
  return ratio >= spikeRatio && obs.value >= floor;
}

function breach(
  rule: SpendRuleId,
  obs: ScopeObservation,
  severity: SpendAlertSeverity,
  ratio: number | null
): SpendBreach {
  return {
    rule,
    scopeType: obs.scopeType,
    scopeId: obs.scopeId,
    severity,
    value: obs.value,
    baseline: obs.baseline,
    ratio,
  };
}

function evaluatePlatformMetric(
  rule: SpendRuleId,
  obs: PlatformObservation,
  floor: number,
  t: SpendThresholds
): SpendBreach[] {
  const ratio = ratioOf(obs);
  if (!isSpike(obs, ratio, t.platformSpikeRatio, floor)) return [];
  const severity = ratio !== null && ratio >= t.platformCriticalRatio ? 'critical' : 'warning';
  const trustedExcluded = obs.total - obs.value;
  return [
    {
      ...breach(rule, obs, severity, ratio),
      value: obs.total,
      ...(trustedExcluded > 0 ? { trustedExcluded } : {}),
    },
  ];
}

/**
 * A platform alert needs standard-tier spend over BOTH floors: enough credits and enough provider cost.
 * Either metric alone is too easy to trip (a cheap model run at volume, a few costly calls).
 */
export function evaluatePlatform(
  credits: PlatformObservation,
  costUsd: PlatformObservation,
  t: SpendThresholds
): SpendBreach[] {
  if (credits.value < t.platformSpikeFloorCredits || costUsd.value < t.platformCostFloorUsd) return [];
  return [
    ...evaluatePlatformMetric('platform_spike', credits, t.platformSpikeFloorCredits, t),
    ...evaluatePlatformMetric('platform_cost_spike', costUsd, t.platformCostFloorUsd, t),
  ];
}

/** A trusted scope gets higher limits, never a mute: past its own ceiling it still pages. */
export function evaluateScope(
  obs: ScopeObservation,
  t: SpendThresholds,
  tier: AccountTier = 'standard'
): SpendBreach[] {
  const rules = scopeRules(obs.scopeType);
  if (!rules) return []; // platform and model scopes are not account-level spend
  const trusted = tier === 'trusted';
  const spikeFloor = trusted ? t.trustedAccountSpikeFloorCredits : t.accountSpikeFloorCredits;
  const ceiling = trusted ? t.trustedAccountCeilingCredits : t.accountCeilingCredits;
  const ratio = ratioOf(obs);
  const mark = (b: SpendBreach): SpendBreach => (trusted ? { ...b, trusted: true as const } : b);
  if (obs.value >= ceiling) return [mark(breach(rules.ceiling, obs, 'critical', ratio))];
  if (isSpike(obs, ratio, t.accountSpikeRatio, spikeFloor)) {
    return [mark(breach(rules.spike, obs, 'warning', ratio))];
  }
  return [];
}

function scopeRules(scopeType: SpendRollupScopeType): { spike: SpendRuleId; ceiling: SpendRuleId } | null {
  switch (scopeType) {
    case 'User':
    case 'Organization':
    case 'Agent':
      return { spike: 'account_spike', ceiling: 'account_ceiling' };
    case 'apiKey':
      return { spike: 'apikey_spike', ceiling: 'apikey_ceiling' };
    default:
      return null;
  }
}
