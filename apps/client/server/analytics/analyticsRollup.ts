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
import { INTERNAL_ACCOUNT_FLAGS, UNCLASSIFIED_SOURCE } from '@bike4mind/common';
import { signupVerdictOf } from '../users/signupClassifier';
import { classifySignupWindow, currentStaffRegex, isCountedUser, loadUserFlags } from './signupCohort';

const DAY_MS = 24 * 60 * 60 * 1000;
const QUERY_DEADLINE_MS = 120_000;
const USER_BATCH = 1000;
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

const bump = (map: Map<string, number>, key: string, by: number) => map.set(key, (map.get(key) ?? 0) + by);

const toRecord = (map: Map<string, number>, limit?: number): Record<string, number> => {
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return Object.fromEntries(limit ? entries.slice(0, limit) : entries);
};

type CohortResult = { signups: IAnalyticsDailySignups; classifiedIds: string[]; suspectedIds: string[] };

async function classifyCohort(
  day: string,
  { now = new Date(), logger = console }: RollupOptions
): Promise<CohortResult> {
  const { start, end } = dayBounds(day);
  const { counted, signalsById, truncated } = await classifySignupWindow(start, end, {
    now,
    deadlineMs: QUERY_DEADLINE_MS,
  });
  if (truncated) logger.warn(`analytics rollup: signup candidate scan truncated for ${day}`);

  const staffRegex = currentStaffRegex();
  const total = truncated
    ? await User.countDocuments({
        createdAt: { $gte: start, $lt: end },
        $nor: [
          ...INTERNAL_ACCOUNT_FLAGS.map(flag => ({ [flag]: true })),
          ...(staffRegex ? [{ email: staffRegex }] : []),
        ],
      }).maxTimeMS(QUERY_DEADLINE_MS)
    : counted.length;

  const signups: IAnalyticsDailySignups = {
    legit: 0,
    suspected: 0,
    unclassified: Math.max(0, total - counted.length),
    bySignal: {},
  };
  const suspectedIds: string[] = [];
  for (const candidate of counted) {
    const signals = signalsById.get(candidate.id) ?? [];
    for (const signal of signals) signups.bySignal[signal] = (signups.bySignal[signal] ?? 0) + 1;
    const verdict = signupVerdictOf(signals, candidate.createdAt, now);
    signups[verdict] += 1;
    if (verdict === 'suspected') suspectedIds.push(candidate.id);
  }
  return { signups, classifiedIds: counted.map(candidate => candidate.id), suspectedIds };
}

/**
 * Classifies the accounts created on `day` and writes the result back: the `suspected` flag on
 * that cohort's user-day rows and the signup counts on the day's analytics_daily row. Unclassified
 * covers unscanned accounts and accounts too young for dormancy; it never counts as legit.
 */
export async function evaluateSignupDay(day: string, options: RollupOptions = {}) {
  const { signups, classifiedIds, suspectedIds } = await classifyCohort(day, options);
  const suspected = new Set(suspectedIds);
  // Write final verdicts directly; a partial run must not clear suspected users or unscanned accounts.
  for (const verdict of [false, true]) {
    const ids = classifiedIds.filter(id => suspected.has(id) === verdict);
    for (let i = 0; i < ids.length; i += USER_BATCH) {
      await AnalyticsUserDay.updateMany(
        { signupDay: day, userId: { $in: ids.slice(i, i + USER_BATCH) } },
        { $set: { suspected: verdict } }
      ).maxTimeMS(QUERY_DEADLINE_MS);
    }
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
    await AnalyticsDaily.updateOne({ day: laterDay }, { $set: { wau, mau } }).maxTimeMS(QUERY_DEADLINE_MS);
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

  const users = await loadUserFlags([...new Set(groups.map(g => g._id.userId))], QUERY_DEADLINE_MS);

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
          ...(!org ? { $unset: { orgId: 1 as const } } : {}),
          $set: {
            day,
            userId,
            ownerType: owners[0].ownerType,
            ...(org ? { orgId: org.ownerId } : {}),
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
  const existingIds: string[] = await AnalyticsUserDay.distinct('userId', { day }).maxTimeMS(QUERY_DEADLINE_MS);
  const staleIds = existingIds.filter(id => !perUser.has(id));
  for (let i = 0; i < staleIds.length; i += USER_BATCH) {
    await AnalyticsUserDay.deleteMany({ day, userId: { $in: staleIds.slice(i, i + USER_BATCH) } }).maxTimeMS(
      QUERY_DEADLINE_MS
    );
  }

  const signups = await evaluateSignupDay(day, options);
  const [wau, mau] = await windowCounts(day);
  // The daily row is the backfill completion marker; leave it absent until all dependent windows refresh.
  await refreshLaterWindows(day);
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
  return { day, dau: perUser.size, wau, mau };
}

/** Re-runs signup classification for the trailing days so late signals (dormancy, API use) land. */
export async function reevaluateRecentSignups(yesterday: string, options: RollupOptions = {}) {
  for (let back = 1; back <= SIGNUP_REEVALUATION_DAYS - 1; back++) {
    const day = shiftDay(yesterday, -back);
    const signups = await evaluateSignupDay(day, options);
    await AnalyticsDaily.updateOne({ day }, { $set: { signups } }).maxTimeMS(QUERY_DEADLINE_MS);
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
