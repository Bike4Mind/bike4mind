import {
  SPEND_BUCKET_MS,
  type ISpendAlertRepository,
  type ISpendRollup,
  type ISpendRollupRepository,
  type SpendAlertRecord,
} from '@bike4mind/common';
import type { SlackAlarmMessage } from '../../events/alarmSlackMessage';
import { platformBaseline, scopeBaseline, windowSums } from './baselines';
import { decideIncidents, type IncidentDecision } from './incidents';
import {
  evaluatePlatform,
  evaluateScope,
  type ScopeObservation,
  type SpendBreach,
  type SpendThresholds,
} from './rules';
import { resolveScopes, scopeMapKey, type ResolvedScope, type ResolveScopeDeps, type ScopeKey } from './resolveScope';
import { buildSpendAlertMessage, type SpendAlertMessageInput } from './slackMessage';

const WINDOW_BUCKETS = 3;
const WINDOW_MS = WINDOW_BUCKETS * SPEND_BUCKET_MS;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS_PER_DAY = DAY_MS / WINDOW_MS;
const SAME_SLOT_DAYS = [7, 14, 21, 28] as const;
const SCOPE_BASELINE_DAYS = 7;
const ACCOUNT_SCOPE_TYPES = ['User', 'Organization', 'Agent', 'apiKey'] as const;
const BREAKDOWN_SIZE = 3;
const PLATFORM_SCOPE_ID = 'all';
const MONGO_DUPLICATE_KEY = 11000;

type SpendLogger = { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

export type EvaluateDeps = {
  rollups: Pick<ISpendRollupRepository, 'sumWindow' | 'windowSeries' | 'latestBucketStart'>;
  alerts: Pick<ISpendAlertRepository, 'findActive' | 'create' | 'update'>;
  resolveScopeDeps: ResolveScopeDeps;
  /** Posting is best effort; a disabled Slack integration passes a no-op, which counts as success. */
  post: (message: SlackAlarmMessage) => Promise<void>;
  messageContext: Pick<SpendAlertMessageInput, 'creditUsd' | 'stage' | 'appUrl' | 'mention'>;
  logger: SpendLogger;
};

type Notification = { kind: 'open' | 'escalate' | 'resolve'; alert: SpendAlertRecord };

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === MONGO_DUPLICATE_KEY;

const creditsOf = (rollup: ISpendRollup | undefined): number => rollup?.credits ?? 0;

async function platformBreaches(
  windowStart: Date,
  windowEnd: Date,
  deps: EvaluateDeps,
  thresholds: SpendThresholds
): Promise<SpendBreach[]> {
  const [current, history] = await Promise.all([
    deps.rollups.sumWindow('platform', windowStart, windowEnd, [PLATFORM_SCOPE_ID]),
    deps.rollups.windowSeries(
      'platform',
      [PLATFORM_SCOPE_ID],
      new Date(windowEnd.getTime() - (SAME_SLOT_DAYS[SAME_SLOT_DAYS.length - 1] + 1) * DAY_MS),
      windowEnd
    ),
  ]);
  const series = history.get(PLATFORM_SCOPE_ID) ?? [];
  const total = current.get(PLATFORM_SCOPE_ID);

  const observe = (field: 'credits' | 'costUsd'): ScopeObservation => {
    // Index 0 is the current window, so the window ending d days ago is d * 96 windows back.
    const everyWindow = windowSums(series, windowEnd, SAME_SLOT_DAYS[SAME_SLOT_DAYS.length - 1] + 1, field);
    // An empty slot is indistinguishable from missing history, so only populated slots count as samples.
    const sameSlot = SAME_SLOT_DAYS.map(days => everyWindow[days * WINDOWS_PER_DAY]).filter(sum => sum > 0);
    const trailing24h = windowSums(series, windowStart, 1, field);
    return {
      scopeType: 'platform',
      scopeId: PLATFORM_SCOPE_ID,
      value: total?.[field] ?? 0,
      baseline: platformBaseline(sameSlot, trailing24h),
    };
  };

  return evaluatePlatform(observe('credits'), observe('costUsd'), thresholds);
}

async function scopeBreachesForType(
  scopeType: (typeof ACCOUNT_SCOPE_TYPES)[number],
  windowStart: Date,
  windowEnd: Date,
  active: SpendAlertRecord[],
  deps: EvaluateDeps,
  thresholds: SpendThresholds
): Promise<{ breaches: SpendBreach[]; values: Map<string, number> }> {
  const totals = await deps.rollups.sumWindow(scopeType, windowStart, windowEnd);
  const candidateFloor = Math.min(thresholds.accountSpikeFloorCredits, thresholds.accountCeilingCredits);

  const candidates = new Set<string>();
  for (const [scopeId, rollup] of totals) if (rollup.credits >= candidateFloor) candidates.add(scopeId);
  // An active incident keeps being observed even when its scope fell out of the window, so it can clear.
  for (const alert of active) if (alert.scopeType === scopeType) candidates.add(alert.scopeId);

  const values = new Map([...candidates].map(scopeId => [scopeId, creditsOf(totals.get(scopeId))]));
  if (candidates.size === 0) return { breaches: [], values };

  const history = await deps.rollups.windowSeries(
    scopeType,
    [...candidates],
    new Date(windowStart.getTime() - SCOPE_BASELINE_DAYS * DAY_MS),
    windowStart
  );
  const breaches = [...candidates].flatMap(scopeId => {
    const baseline = scopeBaseline(windowSums(history.get(scopeId) ?? [], windowStart, SCOPE_BASELINE_DAYS, 'credits'));
    return evaluateScope({ scopeType, scopeId, value: values.get(scopeId) ?? 0, baseline }, thresholds);
  });
  return { breaches, values };
}

/** Writes each decision; returns what to announce. A failed write is reported, never silently dropped. */
async function persistDecisions(
  decisions: IncidentDecision[],
  active: SpendAlertRecord[],
  deps: EvaluateDeps
): Promise<{ notifications: Notification[]; errors: unknown[] }> {
  const activeById = new Map(active.map(alert => [alert.id, alert]));
  const notifications: Notification[] = [];
  const errors: unknown[] = [];

  for (const decision of decisions) {
    try {
      const notification = await persistDecision(decision, activeById, deps);
      if (notification) notifications.push(notification);
    } catch (error) {
      errors.push(error);
      deps.logger.error('spend-monitor-persist-failed', { kind: decision.kind, error });
    }
  }
  return { notifications, errors };
}

async function persistDecision(
  decision: IncidentDecision,
  activeById: Map<string, SpendAlertRecord>,
  deps: EvaluateDeps
): Promise<Notification | null> {
  if (decision.kind === 'open') {
    try {
      return { kind: 'open', alert: await deps.alerts.create(decision.alert) };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      deps.logger.log('spend-monitor-open-lost-race', { openKey: decision.alert.openKey });
      return null;
    }
  }

  const existing = activeById.get(decision.id);
  if (!existing) throw new Error(`spend alert ${decision.id} is not active`);
  const merged: SpendAlertRecord = { ...existing, ...decision.patch };
  const patch = { id: decision.id, ...decision.patch };

  if (decision.kind === 'resolve') {
    // The patch cannot express removal; freeing openKey is what lets the next breach open a new incident.
    await deps.alerts.update(patch, { unset: ['openKey'] });
    return { kind: 'resolve', alert: merged };
  }
  await deps.alerts.update(patch);
  return decision.kind === 'escalate' ? { kind: 'escalate', alert: merged } : null;
}

const platformScope: ResolvedScope = { label: 'Platform', payerType: 'unknown', payerId: null, adminPath: null };

const topEntries = (totals: Map<string, ISpendRollup>, size: number): [string, number][] =>
  [...totals]
    .map(([scopeId, rollup]): [string, number] => [scopeId, rollup.credits])
    .filter(([, credits]) => credits > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, size);

/**
 * Model rollups are platform-wide, so the breakdown is only meaningful for platform incidents.
 * The rollup carries no source dimension, so no source mix is produced.
 */
async function platformBreakdown(
  windowStart: Date,
  windowEnd: Date,
  deps: EvaluateDeps
): Promise<{ breakdown: NonNullable<SpendAlertMessageInput['breakdown']>; accountKeys: ScopeKey[] }> {
  const [models, users, organizations] = await Promise.all([
    deps.rollups.sumWindow('model', windowStart, windowEnd),
    deps.rollups.sumWindow('User', windowStart, windowEnd),
    deps.rollups.sumWindow('Organization', windowStart, windowEnd),
  ]);
  const accounts = [
    ...topEntries(users, BREAKDOWN_SIZE).map(([scopeId, credits]) => ({
      scopeType: 'User' as const,
      scopeId,
      credits,
    })),
    ...topEntries(organizations, BREAKDOWN_SIZE).map(([scopeId, credits]) => ({
      scopeType: 'Organization' as const,
      scopeId,
      credits,
    })),
  ]
    .sort((a, b) => b.credits - a.credits)
    .slice(0, BREAKDOWN_SIZE);

  return {
    breakdown: {
      topModels: topEntries(models, BREAKDOWN_SIZE).map(([model, credits]) => ({ model, credits })),
      // Labels are filled in once the accounts are resolved.
      topAccounts: accounts.map(({ scopeType, scopeId, credits }) => ({
        label: scopeMapKey(scopeType, scopeId),
        credits,
      })),
    },
    accountKeys: accounts.map(({ scopeType, scopeId }) => ({ scopeType, scopeId })),
  };
}

async function buildMessages(
  notifications: Notification[],
  windowStart: Date,
  windowEnd: Date,
  deps: EvaluateDeps
): Promise<{ notification: Notification; message: SlackAlarmMessage }[]> {
  const needsPlatformBreakdown = notifications.some(n => n.kind !== 'resolve' && n.alert.scopeType === 'platform');
  const platform = needsPlatformBreakdown ? await platformBreakdown(windowStart, windowEnd, deps) : null;

  const accountKeys: ScopeKey[] = notifications
    .filter(n => n.alert.scopeType !== 'platform')
    .map(n => ({ scopeType: n.alert.scopeType, scopeId: n.alert.scopeId }));
  const resolved = await resolveScopes([...accountKeys, ...(platform?.accountKeys ?? [])], deps.resolveScopeDeps);

  const topAccounts = platform?.breakdown.topAccounts?.map(account => ({
    ...account,
    label: resolved.get(account.label)?.label ?? account.label,
  }));

  return notifications.map(notification => {
    const { alert } = notification;
    const isPlatform = alert.scopeType === 'platform';
    const scope = isPlatform
      ? platformScope
      : (resolved.get(scopeMapKey(alert.scopeType, alert.scopeId)) ?? {
          ...platformScope,
          label: `${alert.scopeType} ${alert.scopeId}`,
        });
    const breakdown = isPlatform && platform ? { topModels: platform.breakdown.topModels, topAccounts } : undefined;
    return {
      notification,
      message: buildSpendAlertMessage({ kind: notification.kind, alert, scope, breakdown, ...deps.messageContext }),
    };
  });
}

/** Posts best effort. Only a successful post records lastNotifiedValue, so a failed one re-notifies next run. */
async function announce(
  notifications: Notification[],
  windowStart: Date,
  windowEnd: Date,
  now: Date,
  deps: EvaluateDeps
): Promise<number> {
  if (notifications.length === 0) return 0;

  let messages: Awaited<ReturnType<typeof buildMessages>>;
  try {
    messages = await buildMessages(notifications, windowStart, windowEnd, deps);
  } catch (error) {
    deps.logger.error('spend-monitor-message-build-failed', { error });
    return 0;
  }

  let posted = 0;
  for (const { notification, message } of messages) {
    const { kind, alert } = notification;
    try {
      await deps.post(message);
      posted += 1;
      if (kind !== 'resolve') {
        await deps.alerts.update({ id: alert.id, lastNotifiedValue: alert.lastValue, lastNotifiedAt: now });
      }
    } catch (error) {
      deps.logger.error('spend-monitor-post-failed', { kind, alertId: alert.id, error });
    }
  }
  return posted;
}

export async function evaluateSpend(
  now: Date,
  deps: EvaluateDeps,
  thresholds: SpendThresholds
): Promise<{ breaches: number; posted: number }> {
  const latestBucket = await deps.rollups.latestBucketStart();
  if (!latestBucket) return { breaches: 0, posted: 0 };

  const windowEnd = new Date(latestBucket.getTime() + SPEND_BUCKET_MS);
  const windowStart = new Date(windowEnd.getTime() - WINDOW_MS);
  const active = await deps.alerts.findActive();

  const breaches = await platformBreaches(windowStart, windowEnd, deps, thresholds);
  for (const scopeType of ACCOUNT_SCOPE_TYPES) {
    const result = await scopeBreachesForType(scopeType, windowStart, windowEnd, active, deps, thresholds);
    breaches.push(...result.breaches);
  }

  const decisions = decideIncidents(active, breaches, now);
  const { notifications, errors } = await persistDecisions(decisions, active, deps);
  const posted = await announce(notifications, windowStart, windowEnd, now, deps);

  if (errors.length > 0) throw new AggregateError(errors, 'spend-monitor-persist-failed');
  return { breaches: breaches.length, posted };
}
