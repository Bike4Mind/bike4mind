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
};

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
  obs: ScopeObservation,
  floor: number,
  t: SpendThresholds
): SpendBreach[] {
  const ratio = ratioOf(obs);
  if (!isSpike(obs, ratio, t.platformSpikeRatio, floor)) return [];
  const severity = ratio !== null && ratio >= t.platformCriticalRatio ? 'critical' : 'warning';
  return [breach(rule, obs, severity, ratio)];
}

export function evaluatePlatform(
  credits: ScopeObservation,
  costUsd: ScopeObservation,
  t: SpendThresholds
): SpendBreach[] {
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
  const breaches: SpendBreach[] = [];
  if (isSpike(obs, ratio, t.accountSpikeRatio, spikeFloor)) {
    breaches.push(breach(rules.spike, obs, 'warning', ratio));
  }
  if (obs.value >= ceiling) {
    breaches.push(breach(rules.ceiling, obs, 'critical', ratio));
  }
  return trusted ? breaches.map(b => ({ ...b, trusted: true as const })) : breaches;
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
