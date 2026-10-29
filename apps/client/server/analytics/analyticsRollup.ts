import {
  AnalyticsDaily,
  AnalyticsUserDay,
  ANALYTICS_BY_MODEL_LIMIT,
  analyticsDailyRepository,
  analyticsUserDayRepository,
  UsageEvent,
  User,
  type IAnalyticsDailySignups,
  type IAnalyticsUserDay,
} from '@bike4mind/database';
import { internalStaffEmailRegex, parseInternalStaffDomains, UNCLASSIFIED_SOURCE } from '@bike4mind/common';
import { isSuspectedSignup } from '@client/app/utils/signupSignals';
import { classifySignups, DORMANCY_MIN_AGE_MS, SPIKE_BASELINE_HOURS } from '../users/signupClassifier';
import { countByBucket, loadCandidates } from '../users/signupTimeseries';

const DAY_MS = 24 * 60 * 60 * 1000;
const QUERY_DEADLINE_MS = 120_000;
const USER_BATCH = 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAU_WINDOW_DAYS = 28;
const WAU_WINDOW_DAYS = 7;

export const SIGNUP_REEVALUATION_DAYS = 14;

type RollupLogger = { warn: (message: string) => void };
type RollupOptions = { now?: Date; logger?: RollupLogger };

export const formatDay = (date: Date): string => date.toISOString().slice(0, 10);

const dayBounds = (day: string) => {
  const start = new Date(`${day}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(start.getTime()) || formatDay(start) !== day) {
    throw new Error(`Invalid rollup day: ${day}`);
  }
  return { start, end: new Date(start.getTime() + DAY_MS) };
};

const shiftDay = (day: string, days: number) => formatDay(new Date(dayBounds(day).start.getTime() + days * DAY_MS));

// Mongo map keys cannot hold dots or lead with a dollar sign; model ids like "gpt-4.1" do.
const safeKey = (key: string) => key.replace(/\./g, '_').replace(/^\$/, '_');

const bump = (map: Map<string, number>, key: string, by: number) => map.set(key, (map.get(key) ?? 0) + by);

const toRecord = (map: Map<string, number>, limit?: number): Record<string, number> => {
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const merged = new Map<string, number>();
  for (const [key, value] of limit ? entries.slice(0, limit) : entries) bump(merged, safeKey(key), value);
  return Object.fromEntries(merged);
};

type UserFlags = {
  _id: unknown;
  email?: string;
  createdAt?: Date;
  isAdmin?: boolean;
  isSystem?: boolean;
  isSynthetic?: boolean;
};

// Negation of internalAccountCondition: only admin/system/synthetic/staff-domain accounts are excluded, so
// orphaned and non-ObjectId ids still count and DAU matches a direct distinct count over usageevents.
const isCountedUser = (user: UserFlags | undefined, staffRegex: RegExp | null): boolean =>
  !user ||
  !(user.isAdmin || user.isSystem || user.isSynthetic || (staffRegex && user.email && staffRegex.test(user.email)));

const currentStaffRegex = () =>
  internalStaffEmailRegex(parseInternalStaffDomains(process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS));

const OBJECT_ID = /^[a-f\d]{24}$/i;

async function loadUsers(userIds: string[]): Promise<Map<string, UserFlags>> {
  const valid = userIds.filter(id => OBJECT_ID.test(id));
  const users = new Map<string, UserFlags>();
  for (let i = 0; i < valid.length; i += USER_BATCH) {
    const rows = await User.find({ _id: { $in: valid.slice(i, i + USER_BATCH) } })
      .select('_id email createdAt isAdmin isSystem isSynthetic')
      .maxTimeMS(QUERY_DEADLINE_MS)
      .lean<UserFlags[]>();
    for (const row of rows) users.set(String(row._id), row);
  }
  return users;
}

type Signal = string;

type CohortResult = { signups: IAnalyticsDailySignups; suspectedIds: string[] };

async function classifyCohort(day: string, { now = new Date(), logger }: RollupOptions): Promise<CohortResult> {
  const { start, end } = dayBounds(day);
  const staffRegex = currentStaffRegex();
  // A one-day margin each side lets cohort signals (bursts, shared network) see accounts across midnight.
  const scanSince = new Date(start.getTime() - DAY_MS);
  const [{ candidates, truncated }, hourlyCounts] = await Promise.all([
    loadCandidates(scanSince, new Date(end.getTime() + DAY_MS), QUERY_DEADLINE_MS),
    // UTC hours, same baseline window as getSignupTimeseries, so the spike signal agrees with the live view.
    countByBucket(
      new Date(scanSince.getTime() - SPIKE_BASELINE_HOURS * HOUR_MS),
      new Date(end.getTime() + DAY_MS),
      'hour',
      0,
      QUERY_DEADLINE_MS
    ),
  ]);
  if (truncated) logger?.warn(`analytics rollup: signup candidate scan truncated for ${day}`);

  const onDay = candidates.filter(c => c.createdAt >= start && c.createdAt < end);
  const users = await loadUsers(onDay.map(c => c.id));
  const counted = onDay.filter(c => isCountedUser(users.get(c.id), staffRegex));
  const signalsById = classifySignups(candidates, now, hourlyCounts);

  const signups: IAnalyticsDailySignups = { legit: 0, suspected: 0, unclassified: 0, bySignal: {} };
  const suspectedIds: string[] = [];
  for (const candidate of counted) {
    const signals: Signal[] = signalsById.get(candidate.id) ?? [];
    for (const signal of signals) signups.bySignal[signal] = (signups.bySignal[signal] ?? 0) + 1;
    if (isSuspectedSignup(signals as never)) {
      signups.suspected += 1;
      suspectedIds.push(candidate.id);
    } else if (signals.length < 2 && now.getTime() - candidate.createdAt.getTime() < DORMANCY_MIN_AGE_MS) {
      // Too young for dormancy to be evaluable, and one more weak signal would make it suspected.
      signups.unclassified += 1;
    } else {
      signups.legit += 1;
    }
  }
  return { signups, suspectedIds };
}

/**
 * Classifies the accounts created on `day` and writes the result back: the `suspected` flag on
 * that cohort's user-day rows and the signup counts on the day's analytics_daily row. Unclassified
 * means too young for the dormancy signal to be evaluable and not yet suspected; it never counts as legit.
 */
export async function evaluateSignupDay(day: string, options: RollupOptions = {}) {
  const { signups, suspectedIds } = await classifyCohort(day, options);
  // Not atomic: readers between the reset and the re-flag can see suspected=false for the cohort.
  await AnalyticsUserDay.updateMany({ signupDay: day }, { $set: { suspected: false } });
  if (suspectedIds.length > 0) {
    await AnalyticsUserDay.updateMany({ signupDay: day, userId: { $in: suspectedIds } }, { $set: { suspected: true } });
  }
  return signups;
}

/**
 * Suspected verdict for each user. A user already holding user-day rows keeps their verdict (the
 * trailing re-evaluation refreshes recent cohorts); a user's first appearance classifies their signup cohort.
 */
async function resolveSuspected(entries: [string, string | undefined][], options: RollupOptions): Promise<Set<string>> {
  const ids = entries.map(([id]) => id);
  const known = new Set<string>();
  const suspected = new Set<string>();
  for (let i = 0; i < ids.length; i += USER_BATCH) {
    const slice = ids.slice(i, i + USER_BATCH);
    // One row per user (all of a user's rows share the verdict); reading every row would grow with history.
    const rows = await AnalyticsUserDay.aggregate<{ _id: string; suspected: boolean }>([
      { $match: { userId: { $in: slice } } },
      { $sort: { userId: 1, day: 1 } },
      { $group: { _id: '$userId', suspected: { $first: '$suspected' } } },
    ]).option({ maxTimeMS: QUERY_DEADLINE_MS });
    for (const row of rows) {
      known.add(row._id);
      if (row.suspected) suspected.add(row._id);
    }
  }
  const cohorts = new Map<string, Set<string>>();
  for (const [id, signupDay] of entries) {
    if (known.has(id) || !signupDay) continue;
    if (!cohorts.has(signupDay))
      cohorts.set(signupDay, new Set((await classifyCohort(signupDay, options)).suspectedIds));
    if (cohorts.get(signupDay)?.has(id)) suspected.add(id);
  }
  return suspected;
}

/** Recomputes WAU/MAU for rolled-up days after `day`, whose windows include it. */
async function refreshLaterWindows(day: string) {
  const later = await AnalyticsDaily.find({ day: { $gt: day, $lte: shiftDay(day, MAU_WINDOW_DAYS - 1) } }, { day: 1 })
    .maxTimeMS(QUERY_DEADLINE_MS)
    .lean();
  for (const { day: laterDay } of later) {
    const [wau, mau] = await windowCounts(laterDay);
    await AnalyticsDaily.updateOne({ day: laterDay }, { $set: { wau, mau } });
  }
}

const windowCounts = (day: string) =>
  Promise.all([
    analyticsUserDayRepository.countDistinctUsers(shiftDay(day, -(WAU_WINDOW_DAYS - 1)), day),
    analyticsUserDayRepository.countDistinctUsers(shiftDay(day, -(MAU_WINDOW_DAYS - 1)), day),
  ]);

type EventGroup = {
  _id: {
    userId: string;
    ownerType: IAnalyticsUserDay['ownerType'];
    ownerId: string;
    feature: string;
    source?: string;
    model: string;
  };
  requests: number;
  credits: number;
};

/**
 * Rebuilds the user-day rows and the daily row for one UTC day from usageevents. Safe to re-run:
 * every write is an upsert keyed on the day, and rows for users that no longer count are removed.
 */
export async function rollupDay(day: string, options: RollupOptions = {}) {
  const { start, end } = dayBounds(day);
  const computedAt = options.now ?? new Date();
  const staffRegex = currentStaffRegex();

  const groups = await UsageEvent.aggregate<EventGroup>([
    { $match: { status: 'ok', createdAt: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: {
          userId: '$userId',
          ownerType: '$ownerType',
          ownerId: '$ownerId',
          feature: '$feature',
          source: '$source',
          model: '$model',
        },
        requests: { $sum: 1 },
        credits: { $sum: '$creditsCharged' },
      },
    },
  ])
    .allowDiskUse(true)
    .option({ maxTimeMS: QUERY_DEADLINE_MS });

  const users = await loadUsers([...new Set(groups.map(g => g._id.userId))]);

  type Acc = {
    requests: number;
    credits: number;
    features: Set<string>;
    sources: Set<string>;
    byOwner: Map<string, { ownerType: IAnalyticsUserDay['ownerType']; ownerId: string; requests: number }>;
  };
  const perUser = new Map<string, Acc>();
  const byFeature = new Map<string, number>();
  const bySource = new Map<string, number>();
  const byModel = new Map<string, number>();
  let creditsConsumed = 0;

  for (const group of groups) {
    const { userId, ownerType, ownerId, feature, source, model } = group._id;
    if (!isCountedUser(users.get(userId), staffRegex)) continue;
    const acc: Acc = perUser.get(userId) ?? {
      requests: 0,
      credits: 0,
      features: new Set(),
      sources: new Set(),
      byOwner: new Map(),
    };
    perUser.set(userId, acc);
    acc.requests += group.requests;
    acc.credits += group.credits;
    acc.features.add(feature);
    if (source) acc.sources.add(source);
    const ownerKey = `${ownerType}:${ownerId}`;
    const owner = acc.byOwner.get(ownerKey) ?? { ownerType, ownerId, requests: 0 };
    owner.requests += group.requests;
    acc.byOwner.set(ownerKey, owner);
    bump(byFeature, feature, group.requests);
    bump(bySource, source ?? UNCLASSIFIED_SOURCE, group.requests);
    bump(byModel, model, group.requests);
    creditsConsumed += group.credits;
  }

  const suspectedUsers = await resolveSuspected(
    [...perUser.keys()].map(userId => {
      const created = users.get(userId)?.createdAt;
      return [userId, created ? formatDay(new Date(created)) : undefined] as [string, string | undefined];
    }),
    options
  );
  const ops = [...perUser.entries()].map(([userId, acc]) => {
    const owners = [...acc.byOwner.values()].sort((a, b) => b.requests - a.requests);
    const org = owners.find(o => o.ownerType === 'Organization');
    const user = users.get(userId);
    return {
      updateOne: {
        filter: { day, userId },
        update: {
          $set: {
            day,
            userId,
            ownerType: owners[0].ownerType,
            orgId: org?.ownerId,
            requests: acc.requests,
            creditsCharged: acc.credits,
            features: [...acc.features].sort(),
            sources: [...acc.sources].sort(),
            signupDay: user?.createdAt ? formatDay(new Date(user.createdAt)) : undefined,
            suspected: suspectedUsers.has(userId),
          },
        },
        upsert: true,
      },
    };
  });
  for (let i = 0; i < ops.length; i += USER_BATCH) {
    await AnalyticsUserDay.bulkWrite(ops.slice(i, i + USER_BATCH), { ordered: false });
  }
  const existingIds: string[] = await AnalyticsUserDay.distinct('userId', { day });
  const staleIds = existingIds.filter(id => !perUser.has(id));
  for (let i = 0; i < staleIds.length; i += USER_BATCH) {
    await AnalyticsUserDay.deleteMany({ day, userId: { $in: staleIds.slice(i, i + USER_BATCH) } });
  }

  const signups = await evaluateSignupDay(day, options);
  const [wau, mau] = await windowCounts(day);
  await analyticsDailyRepository.upsertDay(day, {
    signups,
    dau: perUser.size,
    wau,
    mau,
    requestsByFeature: toRecord(byFeature),
    requestsBySource: toRecord(bySource),
    requestsByModel: toRecord(byModel, ANALYTICS_BY_MODEL_LIMIT),
    creditsConsumed,
    computedAt,
  });
  await refreshLaterWindows(day);
  return { day, dau: perUser.size, wau, mau };
}

/** Re-runs signup classification for the trailing days so late signals (dormancy, API use) land. */
export async function reevaluateRecentSignups(yesterday: string, options: RollupOptions = {}) {
  for (let back = 1; back <= SIGNUP_REEVALUATION_DAYS - 1; back++) {
    const day = shiftDay(yesterday, -back);
    const signups = await evaluateSignupDay(day, options);
    await AnalyticsDaily.updateOne({ day }, { $set: { signups } });
  }
}

/** Nightly entry point: recompute the day that just ended, then refresh recent signup classification. */
export async function runNightlyRollup(scheduledTime: string, options: RollupOptions = {}) {
  const scheduled = Date.parse(scheduledTime);
  if (!Number.isFinite(scheduled)) throw new Error('A valid scheduled event time is required');
  const yesterday = formatDay(new Date(scheduled - DAY_MS));
  const result = await rollupDay(yesterday, options);
  await reevaluateRecentSignups(yesterday, options);
  return result;
}
