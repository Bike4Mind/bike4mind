import { getPeriodUsedCredits, orgAlertPeriodKey, type IOrgBudgetAlerts, type IUserDetails } from '@bike4mind/common';
import { Organization } from '@bike4mind/database';
import { dispatchOrgAlert, type DispatchOrgAlertInput } from './orgAlertDispatcher';

/** Settings reads and per-key dispatch attempts are memoized this long per process (ms). */
const CACHE_TTL_MS = 30_000;

const settingsCache = new Map<string, { expiresAt: number; alerts: IOrgBudgetAlerts | null }>();
// Every debit after a crossing would otherwise re-run the claim (and the dispatcher's org read)
// for the rest of the month; the durable claim still dedupes across processes.
const recentAttempts = new Map<string, number>();
// Long-lived self-host processes keep this module loaded, so expired entries are swept once a map grows.
const MEMO_SWEEP_SIZE = 1000;

/** Drops cached alert settings so a saved change applies to the next debit in this process. */
export function clearOrgBudgetAlertCache(organizationId?: string): void {
  if (!organizationId) {
    settingsCache.clear();
    recentAttempts.clear();
    return;
  }
  settingsCache.delete(organizationId);
  for (const key of recentAttempts.keys()) {
    if (key.startsWith(`${organizationId}|`)) recentAttempts.delete(key);
  }
}

async function loadSettings(organizationId: string, now: number): Promise<IOrgBudgetAlerts | null> {
  const cached = settingsCache.get(organizationId);
  if (cached && cached.expiresAt > now) return cached.alerts;
  if (settingsCache.size >= MEMO_SWEEP_SIZE) {
    for (const [key, entry] of settingsCache) if (entry.expiresAt <= now) settingsCache.delete(key);
  }
  const org = await Organization.findById(organizationId, { budgetAlerts: 1, personal: 1 }).lean<{
    budgetAlerts?: IOrgBudgetAlerts | null;
    personal?: boolean;
  }>();
  const alerts = org && !org.personal && org.budgetAlerts?.enabled ? org.budgetAlerts : null;
  settingsCache.set(organizationId, { expiresAt: now + CACHE_TTL_MS, alerts });
  return alerts;
}

const attemptKey = (input: Pick<DispatchOrgAlertInput, 'organizationId' | 'kind' | 'scope'> & { periodKey: string }) =>
  `${input.organizationId}|${input.kind}|${input.scope}|${input.periodKey}`;

async function dispatchOnce(input: DispatchOrgAlertInput & { periodKey: string }, now: number): Promise<void> {
  const key = attemptKey(input);
  if ((recentAttempts.get(key) ?? 0) > now) return;
  if (recentAttempts.size >= MEMO_SWEEP_SIZE) {
    for (const [k, expiresAt] of recentAttempts) if (expiresAt <= now) recentAttempts.delete(k);
  }
  recentAttempts.set(key, now + CACHE_TTL_MS);
  await dispatchOrgAlert(input);
}

const fmt = (credits: number): string => Math.round(credits).toLocaleString('en-US');

/**
 * Raises low-balance and percent-of-budget alerts after an org pool debit. State-based: it fires
 * whenever the pool is past a threshold and lets the per-period claim keep it to one send, so a
 * missed crossing (a partial holder, a failed send) is picked up by the next debit.
 */
export async function evaluateOrgBudget(
  event: { organizationId: string; balanceAfter: number },
  now: Date = new Date()
): Promise<void> {
  const nowMs = now.getTime();
  const alerts = await loadSettings(event.organizationId, nowMs);
  if (!alerts) return;
  const periodKey = orgAlertPeriodKey(now);
  const base = { organizationId: event.organizationId, periodKey };

  const low = alerts.lowBalanceCredits;
  if (low != null && Number.isFinite(event.balanceAfter) && event.balanceAfter <= low) {
    await dispatchOnce(
      {
        ...base,
        kind: 'low_balance',
        scope: `low:${low}`,
        title: 'Credits running low',
        message: `Your organization's credit pool is down to ${fmt(event.balanceAfter)} credits, at or below the ${fmt(low)} credit alert you set. The owner can add credits from the Billing tab to avoid interruptions.`,
      },
      nowMs
    );
  }

  const budget = alerts.monthlyBudgetCredits;
  const thresholds = Array.isArray(alerts.percentThresholds) ? alerts.percentThresholds : [];
  if (!budget || budget <= 0 || thresholds.length === 0) return;
  const pending = thresholds.some(
    pct => (recentAttempts.get(attemptKey({ ...base, kind: 'budget_threshold', scope: `pct:${pct}` })) ?? 0) <= nowMs
  );
  if (!pending) return;

  // Member rows only: usage by the org service account (org-owned API keys) is tracked per key, not here.
  const org = await Organization.findById(event.organizationId, { userDetails: 1 }).lean<{
    userDetails?: Array<Pick<IUserDetails, 'usedCredits' | 'periodStart'>>;
  }>();
  const spent = (org?.userDetails ?? []).reduce((sum, row) => sum + getPeriodUsedCredits(row, now), 0);
  for (const pct of [...new Set(thresholds)].sort((a, b) => a - b)) {
    if (spent < (budget * pct) / 100) break;
    await dispatchOnce(
      {
        ...base,
        kind: 'budget_threshold',
        scope: `pct:${pct}`,
        title: `${pct}% of monthly credit budget used`,
        message: `Your organization has used ${fmt(spent)} of its ${fmt(budget)} credit monthly budget (${pct}% alert). Review usage from the Members tab.`,
      },
      nowMs
    );
  }
}
