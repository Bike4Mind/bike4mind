import {
  SPEND_FREEZE_SCOPE_TYPES,
  type ISpendAlertRepository,
  type SpendAlertAutoPause,
  type SpendAlertRecord,
  type SpendAutoPauseMode,
  type SpendFreezeScope,
  type SpendFreezeScopeType,
  type SpendRuleId,
} from '@bike4mind/common';
import type { SlackAlarmMessage } from '../../events/alarmSlackMessage';
import type { AccountTier } from './rules';

export type AutoPauseConfig = {
  mode: SpendAutoPauseMode;
  /** Credits per 15-minute window; 0 turns automatic pausing off for that tier. */
  minCreditsByTier: Record<AccountTier, number>;
};

export type AutoPauseCandidate = {
  alert: SpendAlertRecord;
  scope: SpendFreezeScope;
  tier: AccountTier;
  thresholdCredits: number;
};

export type AutoPauseFreezeInput = {
  scope: SpendFreezeScope;
  rule: SpendRuleId;
  spendAlertId: string;
  reason: string;
};

export type AutoPauseDeps = {
  alerts: Pick<ISpendAlertRepository, 'findActive' | 'recordAutoPause'>;
  /**
   * Applies a freeze as the automatic actor. Idempotent: an already frozen scope returns its active freeze,
   * and `byThisIncident` says whether that freeze was applied for `spendAlertId` (now or on an earlier run).
   */
  freeze: (input: AutoPauseFreezeInput) => Promise<{ freezeId: string; byThisIncident: boolean }>;
  post: (message: SlackAlarmMessage) => Promise<void>;
  /** Spend monitor admin page, linked from the alarm. */
  adminUrl: string;
  logger: { log: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
};

const ACCOUNT_TIERS: ReadonlySet<string> = new Set<AccountTier>(['standard', 'paid', 'trusted']);
const FREEZABLE_SCOPE_TYPES: ReadonlySet<string> = new Set<string>(SPEND_FREEZE_SCOPE_TYPES);

/** Reasons the tier fell back to standard because the account could not be read; never paused on. */
const UNCERTAIN_TIER_REASONS: ReadonlySet<string> = new Set(['account_context_unavailable', 'risk_flags_unknown']);

const isFreezableScopeType = (scopeType: string): scopeType is SpendFreezeScopeType =>
  FREEZABLE_SCOPE_TYPES.has(scopeType);

/** The tier the spend rules applied, as breachContext in incidents.ts records it. */
const tierOf = (alert: SpendAlertRecord): AccountTier => {
  const tier = alert.context.accountTier;
  return typeof tier === 'string' && ACCOUNT_TIERS.has(tier) ? (tier as AccountTier) : 'standard';
};

const tierIsUncertain = (alert: SpendAlertRecord): boolean => {
  const reasons = alert.context.policyReasons;
  return Array.isArray(reasons) && reasons.some(reason => UNCERTAIN_TIER_REASONS.has(String(reason)));
};

/** Undecided, or decided in shadow mode and now evaluated in enforce mode. */
const awaitsDecision = (alert: SpendAlertRecord, mode: SpendAutoPauseMode): boolean =>
  !alert.autoPause || (mode === 'enforce' && alert.autoPause.mode !== 'enforce');

/**
 * Open incidents on a freezable payer that breached in the latest window (clearRuns 0, so lastValue is
 * that window's spend) at or above their tier's threshold. Acknowledged incidents are left to the admin
 * handling them; an incident whose tier is a fallback for an unreadable account is never paused.
 */
export function selectAutoPauseCandidates(alerts: SpendAlertRecord[], config: AutoPauseConfig): AutoPauseCandidate[] {
  if (config.mode === 'off') return [];
  const candidates: AutoPauseCandidate[] = [];
  for (const alert of alerts) {
    if (alert.status !== 'open' || alert.clearRuns > 0 || !awaitsDecision(alert, config.mode)) continue;
    if (!isFreezableScopeType(alert.scopeType) || tierIsUncertain(alert)) continue;
    const tier = tierOf(alert);
    const thresholdCredits = config.minCreditsByTier[tier];
    if (thresholdCredits <= 0 || alert.lastValue < thresholdCredits) continue;
    candidates.push({ alert, scope: { scopeType: alert.scopeType, scopeId: alert.scopeId }, tier, thresholdCredits });
  }
  return candidates;
}

const formatCredits = (credits: number): string => Math.round(credits).toLocaleString('en-US');

const pauseReason = ({ alert, tier, thresholdCredits }: AutoPauseCandidate): string =>
  `Automatic pause: ${formatCredits(alert.lastValue)} credits in 15 minutes reached the ${tier} threshold of ` +
  `${formatCredits(thresholdCredits)} (incident ${alert.id}, rule ${alert.rule}).`;

const pausedMessage = (candidate: AutoPauseCandidate, adminUrl: string): SlackAlarmMessage => {
  const { scope, alert, tier, thresholdCredits } = candidate;
  const text =
    `Spending paused automatically for ${scope.scopeType} ${scope.scopeId}: ` +
    `${formatCredits(alert.lastValue)} credits in 15 minutes, ${tier} threshold ${formatCredits(thresholdCredits)}.`;
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `<${adminUrl}|Review or lift it on Spend monitor>` }] },
    ],
  };
};

/**
 * Evaluates the active incidents for automatic pausing. Shadow mode records "would pause" on the
 * incident; enforce mode freezes the payer through the injected freeze, posts an alarm and records it.
 * The decision is recorded last, so a run that fails after the freeze retries the alarm (a duplicate
 * post is preferred over none). One incident failing does not stop the others; all failures are
 * rethrown together at the end.
 */
export async function runAutoPause(
  now: Date,
  deps: AutoPauseDeps,
  config: AutoPauseConfig
): Promise<{ shadow: number; paused: number }> {
  if (config.mode === 'off') return { shadow: 0, paused: 0 };
  const candidates = selectAutoPauseCandidates(await deps.alerts.findActive(), config);
  const errors: unknown[] = [];
  let shadow = 0;
  let paused = 0;

  for (const candidate of candidates) {
    const { alert, scope, tier, thresholdCredits } = candidate;
    const decision: SpendAlertAutoPause = {
      mode: config.mode,
      decidedAt: now,
      tier,
      thresholdCredits,
      valueCredits: alert.lastValue,
    };
    try {
      if (config.mode === 'shadow') {
        if (!(await deps.alerts.recordAutoPause(alert.id, decision))) continue;
        shadow += 1;
        deps.logger.log('spend-monitor-auto-pause-shadow', { alertId: alert.id, ...scope, tier, thresholdCredits });
        continue;
      }
      const { freezeId, byThisIncident } = await deps.freeze({
        scope,
        rule: alert.rule,
        spendAlertId: alert.id,
        reason: pauseReason(candidate),
      });
      if (byThisIncident) await deps.post(pausedMessage(candidate, deps.adminUrl));
      const recorded = await deps.alerts.recordAutoPause(
        alert.id,
        byThisIncident ? { ...decision, freezeId } : decision
      );
      deps.logger.log('spend-monitor-auto-pause', { alertId: alert.id, ...scope, freezeId, byThisIncident, recorded });
      if (byThisIncident) paused += 1;
    } catch (error) {
      deps.logger.warn('spend-monitor-auto-pause-failed', { alertId: alert.id, ...scope, error: String(error) });
      errors.push(error);
    }
  }

  if (errors.length > 0) throw new AggregateError(errors, `Automatic pause failed for ${errors.length} incident(s)`);
  return { shadow, paused };
}
