import {
  SPEND_BUCKET_MS,
  type ISpendAlertRepository,
  type ISpendRollup,
  type ISpendRollupRepository,
  type SpendAlertRecord,
  type SpendSeriesPoint,
} from '@bike4mind/common';
import type { SlackAlarmMessage } from '../../events/alarmSlackMessage';
import { platformBaseline, scopeBaseline, SPEND_WINDOW_MS, windowSums } from './baselines';
import { decideIncidents, type IncidentDecision } from './incidents';
import {
  evaluatePlatform,
  evaluateScope,
  type PlatformObservation,
  type SpendBreach,
  type SpendThresholds,
} from './rules';
import { resolveScopes, scopeMapKey, type ResolvedScope, type ResolveScopeDeps, type ScopeKey } from './resolveScope';
import { buildSpendAlertMessage, type SpendAlertMessageInput } from './slackMessage';
import { resolveTrustedScopes, type SpendTrustConfig } from './trust';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS_PER_DAY = DAY_MS / SPEND_WINDOW_MS;
const SAME_SLOT_DAYS = [7, 14, 21, 28] as const;
const SCOPE_BASELINE_DAYS = 7;
const ACCOUNT_SCOPE_TYPES = ['User', 'Organization', 'Agent', 'apiKey'] as const;
const TOP_ACCOUNTS = 5;
const TOP_MODELS = 3;
const PLATFORM_SCOPE_ID = 'all';
const MONGO_DUPLICATE_KEY = 11000;

type SpendLogger = { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

export type EvaluateDeps = {
  rollups: Pick<ISpendRollupRepository, 'sumWindow' | 'windowSeries' | 'latestBucketStart' | 'sourceMix'>;
  alerts: Pick<ISpendAlertRepository, 'findActive' | 'create' | 'update' | 'applyEvaluation'>;
  resolveScopeDeps: ResolveScopeDeps;
  /** Posting is best effort; a disabled Slack integration passes a no-op, which counts as success. */
  post: (message: SlackAlarmMessage) => Promise<void>;
  messageContext: Pick<SpendAlertMessageInput, 'creditUsd' | 'stage' | 'appUrl' | 'mention'>;
  logger: SpendLogger;
};

type Notification = { kind: 'open' | 'escalate' | 'resolve'; alert: SpendAlertRecord };

type AccountTotals = Map<string, ISpendRollup>;
type AccountScopeType = (typeof ACCOUNT_SCOPE_TYPES)[number];
/** Window totals per account scope type, summed once for detection and reused for the platform breakdown. */
type WindowAccountTotals = Map<AccountScopeType, AccountTotals>;
type EvaluatedWindow = { start: Date; end: Date; accountTotals: WindowAccountTotals };

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === MONGO_DUPLICATE_KEY;

const creditsOf = (rollup: ISpendRollup | undefined): number => rollup?.credits ?? 0;

/** Owner scopes split the ledger between them (each usage row has one owner), so their sums never overlap. */
const OWNER_SCOPE_TYPES: ReadonlySet<AccountScopeType> = new Set(['User', 'Organization', 'Agent']);
const PLATFORM_HISTORY_DAYS = SAME_SLOT_DAYS[SAME_SLOT_DAYS.length - 1] + 1;

/** Credits spent by the trusted owner scopes found this window, now and over the platform history range. */
type TrustedSpend = { current: number; series: SpendSeriesPoint[] };

/**
 * Only trusted scopes that are candidates this window are counted: a trusted account active in the history
 * but quiet now stays in the baseline, which the baseline's median absorbs.
 */
async function trustedOwnerSpend(
  perType: ScopeCandidates[],
  trustedKeys: ReadonlySet<string>,
  windowEnd: Date,
  deps: EvaluateDeps
): Promise<TrustedSpend> {
  const spend: TrustedSpend = { current: 0, series: [] };
  for (const { scopeType, totals, candidates } of perType) {
    if (!OWNER_SCOPE_TYPES.has(scopeType)) continue;
    const trustedIds = candidates.filter(scopeId => trustedKeys.has(scopeMapKey(scopeType, scopeId)));
    if (trustedIds.length === 0) continue;
    for (const scopeId of trustedIds) spend.current += creditsOf(totals.get(scopeId));
    const history = await deps.rollups.windowSeries(
      scopeType,
      trustedIds,
      new Date(windowEnd.getTime() - PLATFORM_HISTORY_DAYS * DAY_MS),
      windowEnd
    );
    for (const points of history.values()) spend.series.push(...points);
  }
  return spend;
}

/** Fraction of a window's credits that is standard-tier; 1 for an empty window. */
const standardShare = (totalCredits: number, standardCredits: number): number =>
  totalCredits > 0 ? standardCredits / totalCredits : 1;

/**
 * Standard-tier share of each window's spend, newest window first. Owner rollups carry no provider
 * cost, so trusted cost is estimated at the platform's own cost per credit in that window.
 */
function standardWindowSums(
  platformSeries: SpendSeriesPoint[],
  trustedSeries: SpendSeriesPoint[],
  windowEnd: Date
): { credits: number[]; costUsd: number[] } {
  const credits = windowSums(platformSeries, windowEnd, PLATFORM_HISTORY_DAYS, 'credits');
  const costUsd = windowSums(platformSeries, windowEnd, PLATFORM_HISTORY_DAYS, 'costUsd');
  const trusted = windowSums(trustedSeries, windowEnd, PLATFORM_HISTORY_DAYS, 'credits');
  const standardCredits = credits.map((total, i) => Math.max(0, total - trusted[i]));
  return {
    credits: standardCredits,
    costUsd: costUsd.map((total, i) => total * standardShare(credits[i], standardCredits[i])),
  };
}

/**
 * The floors and the ratio are judged on standard-tier spend, so heavy trusted use cannot page the
 * platform on its own; the reported value stays the full platform total.
 */
async function platformBreaches(
  windowStart: Date,
  windowEnd: Date,
  trusted: TrustedSpend,
  deps: EvaluateDeps,
  thresholds: SpendThresholds
): Promise<SpendBreach[]> {
  const [current, history] = await Promise.all([
    deps.rollups.sumWindow('platform', windowStart, windowEnd, [PLATFORM_SCOPE_ID]),
    deps.rollups.windowSeries(
      'platform',
      [PLATFORM_SCOPE_ID],
      new Date(windowEnd.getTime() - PLATFORM_HISTORY_DAYS * DAY_MS),
      windowEnd
    ),
  ]);
  const total = current.get(PLATFORM_SCOPE_ID);
  const totalCredits = total?.credits ?? 0;
  const totalCost = total?.costUsd ?? 0;
  const standard = standardWindowSums(history.get(PLATFORM_SCOPE_ID) ?? [], trusted.series, windowEnd);
  const standardCredits = Math.max(0, totalCredits - trusted.current);

  const observe = (field: 'credits' | 'costUsd'): PlatformObservation => {
    // Index 0 is the current window, so the window ending d days ago is d * WINDOWS_PER_DAY windows back.
    const everyWindow = standard[field];
    // An empty slot is indistinguishable from missing history, so only populated slots count as samples.
    const sameSlot = SAME_SLOT_DAYS.map(days => everyWindow[days * WINDOWS_PER_DAY]).filter(sum => sum > 0);
    const trailing24h = everyWindow.slice(1, 1 + WINDOWS_PER_DAY);
    const totalValue = field === 'credits' ? totalCredits : totalCost;
    const value = field === 'credits' ? standardCredits : totalCost * standardShare(totalCredits, standardCredits);
    return {
      scopeType: 'platform',
      scopeId: PLATFORM_SCOPE_ID,
      value,
      total: totalValue,
      baseline: platformBaseline(sameSlot, trailing24h),
    };
  };

  return evaluatePlatform(observe('credits'), observe('costUsd'), thresholds);
}

type ScopeCandidates = { scopeType: AccountScopeType; totals: AccountTotals; candidates: string[] };

async function scopeCandidatesForType(
  scopeType: AccountScopeType,
  windowStart: Date,
  windowEnd: Date,
  active: SpendAlertRecord[],
  deps: EvaluateDeps,
  thresholds: SpendThresholds
): Promise<ScopeCandidates> {
  const totals = await deps.rollups.sumWindow(scopeType, windowStart, windowEnd);
  // Trust is not known yet, so the lowest limit of either tier decides who is worth a closer look.
  const candidateFloor = Math.min(
    thresholds.accountSpikeFloorCredits,
    thresholds.accountCeilingCredits,
    thresholds.trustedAccountSpikeFloorCredits,
    thresholds.trustedAccountCeilingCredits
  );

  const candidates = new Set<string>();
  for (const [scopeId, rollup] of totals) if (rollup.credits >= candidateFloor) candidates.add(scopeId);
  // An active incident keeps being observed even when its scope fell out of the window, so it can clear.
  for (const alert of active) if (alert.scopeType === scopeType) candidates.add(alert.scopeId);
  return { scopeType, totals, candidates: [...candidates] };
}

async function scopeBreaches(
  { scopeType, totals, candidates }: ScopeCandidates,
  windowStart: Date,
  trustedKeys: ReadonlySet<string>,
  deps: EvaluateDeps,
  thresholds: SpendThresholds
): Promise<SpendBreach[]> {
  if (candidates.length === 0) return [];
  const history = await deps.rollups.windowSeries(
    scopeType,
    candidates,
    new Date(windowStart.getTime() - SCOPE_BASELINE_DAYS * DAY_MS),
    windowStart
  );
  return candidates.flatMap(scopeId => {
    const baseline = scopeBaseline(windowSums(history.get(scopeId) ?? [], windowStart, SCOPE_BASELINE_DAYS, 'credits'));
    const tier = trustedKeys.has(scopeMapKey(scopeType, scopeId)) ? 'trusted' : 'standard';
    return evaluateScope({ scopeType, scopeId, value: creditsOf(totals.get(scopeId)), baseline }, thresholds, tier);
  });
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

  // The patch cannot express removal; freeing openKey on resolve is what lets the next breach open a new incident.
  const applied = await deps.alerts.applyEvaluation(
    { id: decision.id, ...decision.patch },
    decision.kind === 'resolve' ? { unset: ['openKey'] } : undefined
  );
  if (!applied) {
    deps.logger.log('spend-monitor-evaluation-lost-race', { alertId: decision.id, kind: decision.kind });
    return null;
  }
  // A resolve for an incident the channel never saw announced would be a stray message.
  if (decision.kind === 'resolve') return existing.lastNotifiedAt ? { kind: 'resolve', alert: merged } : null;
  if (decision.kind === 'update') return null;
  // An incident whose opening post never landed is still announced as an open.
  return { kind: existing.lastNotifiedAt ? 'escalate' : 'open', alert: merged };
}

const platformScope: ResolvedScope = { label: 'Platform', payerType: 'unknown', payerId: null, adminPath: null };

const topEntries = (totals: Map<string, ISpendRollup>, size: number): [string, number][] =>
  [...totals]
    .map(([scopeId, rollup]): [string, number] => [scopeId, rollup.credits])
    .filter(([, credits]) => credits > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, size);

/** Model rollups are platform-wide, so the model and account breakdown is only meaningful for platform incidents. */
async function platformBreakdown(
  { start, end, accountTotals }: EvaluatedWindow,
  deps: EvaluateDeps
): Promise<{ breakdown: NonNullable<SpendAlertMessageInput['breakdown']>; accountKeys: ScopeKey[] }> {
  const models = await deps.rollups.sumWindow('model', start, end);
  const accounts = [
    ...topEntries(accountTotals.get('User') ?? new Map(), TOP_ACCOUNTS).map(([scopeId, credits]) => ({
      scopeType: 'User' as const,
      scopeId,
      credits,
    })),
    ...topEntries(accountTotals.get('Organization') ?? new Map(), TOP_ACCOUNTS).map(([scopeId, credits]) => ({
      scopeType: 'Organization' as const,
      scopeId,
      credits,
    })),
  ]
    .sort((a, b) => b.credits - a.credits)
    .slice(0, TOP_ACCOUNTS);

  return {
    breakdown: {
      topModels: topEntries(models, TOP_MODELS).map(([model, credits]) => ({ model, credits })),
      // Labels are filled in once the accounts are resolved.
      topAccounts: accounts.map(({ scopeType, scopeId, credits }) => ({
        label: scopeMapKey(scopeType, scopeId),
        credits,
      })),
    },
    accountKeys: accounts.map(({ scopeType, scopeId }) => ({ scopeType, scopeId })),
  };
}

type SourceMix = Record<string, number>;

/**
 * Credits per completion source (web, cli, desktop, ...) for each announced scope. Best effort: a failed
 * read is logged and the alert still goes out without the mix.
 */
async function sourceMixByScope(
  keys: ScopeKey[],
  window: EvaluatedWindow,
  deps: EvaluateDeps
): Promise<Map<string, SourceMix>> {
  const mix = new Map<string, SourceMix>();
  if (keys.length === 0) return mix;
  try {
    for (const row of await deps.rollups.sourceMix(window.start, window.end, keys)) {
      if (row.credits <= 0) continue;
      const key = scopeMapKey(row.scopeType, row.scopeId);
      mix.set(key, { ...mix.get(key), [row.source]: row.credits });
    }
  } catch (error) {
    deps.logger.error('spend-monitor-source-mix-failed', { error });
  }
  return mix;
}

async function buildMessages(
  notifications: Notification[],
  window: EvaluatedWindow,
  deps: EvaluateDeps
): Promise<{ notification: Notification; message: SlackAlarmMessage }[]> {
  const needsPlatformBreakdown = notifications.some(n => n.kind !== 'resolve' && n.alert.scopeType === 'platform');
  const platform = needsPlatformBreakdown ? await platformBreakdown(window, deps) : null;

  const accountKeys: ScopeKey[] = notifications
    .filter(n => n.alert.scopeType !== 'platform')
    .map(n => ({ scopeType: n.alert.scopeType, scopeId: n.alert.scopeId }));
  const resolved = await resolveScopes([...accountKeys, ...(platform?.accountKeys ?? [])], deps.resolveScopeDeps);
  const announcedKeys: ScopeKey[] = notifications
    .filter(n => n.kind !== 'resolve')
    .map(n => ({ scopeType: n.alert.scopeType, scopeId: n.alert.scopeId }));
  const sourceMix = await sourceMixByScope(announcedKeys, window, deps);

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
    const sources = sourceMix.get(scopeMapKey(alert.scopeType, alert.scopeId));
    const breakdown =
      isPlatform && platform
        ? { topModels: platform.breakdown.topModels, topAccounts, sources }
        : sources
          ? { topModels: [], sources }
          : undefined;
    return {
      notification,
      message: buildSpendAlertMessage({ kind: notification.kind, alert, scope, breakdown, ...deps.messageContext }),
    };
  });
}

/**
 * Posts, then stamps the lastNotified* fields: delivery is at-least-once. A failed open or escalate post
 * leaves the stamp unset, so the next run announces it again; a failed resolve post is not retried. A
 * failed stamp after a landed post is returned so the run fails, and the next window re-announces the
 * same incident: a duplicate post is preferred over a missed one.
 */
async function announce(
  notifications: Notification[],
  window: EvaluatedWindow,
  now: Date,
  deps: EvaluateDeps
): Promise<{ posted: number; errors: unknown[] }> {
  const errors: unknown[] = [];
  if (notifications.length === 0) return { posted: 0, errors };

  let messages: Awaited<ReturnType<typeof buildMessages>>;
  try {
    messages = await buildMessages(notifications, window, deps);
  } catch (error) {
    deps.logger.error('spend-monitor-message-build-failed', { error });
    return { posted: 0, errors };
  }

  let posted = 0;
  for (const { notification, message } of messages) {
    const { kind, alert } = notification;
    try {
      await deps.post(message);
    } catch (error) {
      deps.logger.error('spend-monitor-post-failed', { kind, alertId: alert.id, error });
      continue;
    }
    posted += 1;
    if (kind === 'resolve') continue;
    try {
      await deps.alerts.update({
        id: alert.id,
        lastNotifiedValue: alert.lastValue,
        lastNotifiedSeverity: alert.severity,
        lastNotifiedAt: now,
      });
    } catch (error) {
      errors.push(error);
      deps.logger.error('spend-monitor-notify-bookkeeping-failed', { kind, alertId: alert.id, error });
    }
  }
  return { posted, errors };
}

export async function evaluateSpend(
  now: Date,
  deps: EvaluateDeps,
  thresholds: SpendThresholds,
  trust: SpendTrustConfig
): Promise<{ breaches: number; posted: number }> {
  const latestBucket = await deps.rollups.latestBucketStart();
  if (!latestBucket) return { breaches: 0, posted: 0 };

  const windowEnd = new Date(latestBucket.getTime() + SPEND_BUCKET_MS);
  const windowStart = new Date(windowEnd.getTime() - SPEND_WINDOW_MS);
  const active = await deps.alerts.findActive();

  const breaches: SpendBreach[] = [];
  const accountTotals: WindowAccountTotals = new Map();
  const perType: ScopeCandidates[] = [];
  for (const scopeType of ACCOUNT_SCOPE_TYPES) {
    const candidates = await scopeCandidatesForType(scopeType, windowStart, windowEnd, active, deps, thresholds);
    perType.push(candidates);
    accountTotals.set(scopeType, candidates.totals);
  }
  // Failing closed: if the lookup fails every account is held to the standard thresholds, so alerts still fire.
  const trustedKeys = await resolveTrustedScopes(
    perType.flatMap(({ scopeType, candidates }) => candidates.map(scopeId => ({ scopeType, scopeId }))),
    trust,
    deps.resolveScopeDeps
  ).catch(error => {
    deps.logger.error('spend-monitor-trust-lookup-failed', { error });
    return new Set<string>();
  });
  // Same fail-closed rule: with no trusted spend subtracted, the platform is judged on its full total.
  const trustedSpend = await trustedOwnerSpend(perType, trustedKeys, windowEnd, deps).catch(error => {
    deps.logger.error('spend-monitor-trusted-spend-failed', { error });
    return { current: 0, series: [] } satisfies TrustedSpend;
  });
  breaches.push(...(await platformBreaches(windowStart, windowEnd, trustedSpend, deps, thresholds)));
  for (const candidates of perType) {
    breaches.push(...(await scopeBreaches(candidates, windowStart, trustedKeys, deps, thresholds)));
  }
  const window: EvaluatedWindow = { start: windowStart, end: windowEnd, accountTotals };

  const decisions = decideIncidents(active, breaches, now, windowEnd);
  const persisted = await persistDecisions(decisions, active, deps);
  const announced = await announce(persisted.notifications, window, now, deps);

  const errors = [...persisted.errors, ...announced.errors];
  if (errors.length > 0) throw new AggregateError(errors, 'spend-monitor-persist-failed');
  return { breaches: breaches.length, posted: announced.posted };
}
