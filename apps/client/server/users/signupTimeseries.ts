import { User, UserApiKey } from '@bike4mind/database';
import {
  emptySignalCounts,
  isSuspectedSignup,
  type SignupVerdicts,
  type SignupTimeseries,
  type SignupTimeseriesBucket,
  type SignupTimeseriesRange,
} from '@client/app/utils/signupSignals';
import { classifySignups, SPIKE_BASELINE_HOURS, type SignupCandidate } from './signupClassifier';

/** Newest signups classified per request; older ones in range are counted but left unclassified. */
export const TIMESERIES_SCAN_LIMIT = 20000;
export const TIMESERIES_KEY_SCAN_LIMIT = 50000;
const QUERY_DEADLINE_MS = 5000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const RANGE_SHAPES: Record<
  SignupTimeseriesRange,
  { unit: 'hour' | 'day'; buckets: number; baselineBuckets: number }
> = {
  // Baseline: the preceding week of hours, or the preceding four weeks of days.
  '24h': { unit: 'hour', buckets: 24, baselineBuckets: 168 },
  '7d': { unit: 'hour', buckets: 168, baselineBuckets: 168 },
  '30d': { unit: 'day', buckets: 30, baselineBuckets: 28 },
  '90d': { unit: 'day', buckets: 90, baselineBuckets: 28 },
};
/** A baseline from fewer preceding buckets than this is noise, so it is left out. */
const MIN_BASELINE_BUCKETS = 6;

/** `+05:30` style offset for $dateTrunc; minutes east of UTC. */
export const formatTzOffset = (minutes: number) => {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
};

/** Start of the bucket holding `date`, in the viewer's offset. Must agree with $dateTrunc below. */
function truncate(date: Date, unit: 'hour' | 'day', tzOffsetMinutes: number): number {
  const size = unit === 'hour' ? HOUR_MS : DAY_MS;
  const local = date.getTime() + tzOffsetMinutes * 60 * 1000;
  return local - (((local % size) + size) % size) - tzOffsetMinutes * 60 * 1000;
}

function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

async function countByBucket(since: Date, until: Date, unit: 'hour' | 'day', tzOffsetMinutes: number) {
  // Only createdAt is read, so this is a covered scan of the createdAt index.
  const rows = await User.aggregate<{ _id: Date; count: number }>([
    { $match: { createdAt: { $gte: since, $lt: until } } },
    {
      $group: {
        _id: { $dateTrunc: { date: '$createdAt', unit, timezone: formatTzOffset(tzOffsetMinutes) } },
        count: { $sum: 1 },
      },
    },
  ])
    .hint({ createdAt: 1 })
    .option({ maxTimeMS: QUERY_DEADLINE_MS });
  return new Map(rows.map(row => [new Date(row._id).getTime(), row.count]));
}

async function loadCandidates(since: Date, until: Date) {
  const [users, keys] = await Promise.all([
    User.find({ createdAt: { $gte: since, $lt: until } })
      .select('_id email createdAt lastActiveAt signupMeta.ip signupMeta.isDatacenter signupMeta.wafBotSignal')
      .hint({ createdAt: 1 })
      .sort({ createdAt: -1 })
      .limit(TIMESERIES_SCAN_LIMIT + 1)
      .maxTimeMS(QUERY_DEADLINE_MS)
      .lean(),
    // A key made within 24h of a signup in range was itself made in range, so the bounded createdAt
    // scan finds it without an unbounded `userId: { $in }` list.
    UserApiKey.find({ createdAt: { $gte: since, $lt: until } })
      .select('userId createdAt lastUsedAt')
      .hint({ createdAt: 1 })
      .limit(TIMESERIES_KEY_SCAN_LIMIT + 1)
      .maxTimeMS(QUERY_DEADLINE_MS)
      .lean(),
  ]);
  const firstKeyAt = new Map<string, Date>();
  const lastKeyUseAt = new Map<string, Date>();
  for (const key of keys.slice(0, TIMESERIES_KEY_SCAN_LIMIT)) {
    const createdAt = new Date(key.createdAt);
    const current = firstKeyAt.get(key.userId);
    if (!current || createdAt < current) firstKeyAt.set(key.userId, createdAt);
    if (key.lastUsedAt) {
      const usedAt = new Date(key.lastUsedAt);
      const latest = lastKeyUseAt.get(key.userId);
      if (!latest || usedAt > latest) lastKeyUseAt.set(key.userId, usedAt);
    }
  }
  const candidates: SignupCandidate[] = users.slice(0, TIMESERIES_SCAN_LIMIT).map(user => ({
    id: String(user._id),
    email: user.email ?? null,
    createdAt: new Date(user.createdAt),
    lastActiveAt: user.lastActiveAt ? new Date(user.lastActiveAt) : null,
    signupMeta: user.signupMeta ?? null,
    firstApiKeyAt: firstKeyAt.get(String(user._id)) ?? null,
    lastApiUseAt: lastKeyUseAt.get(String(user._id)) ?? null,
  }));
  return {
    candidates,
    truncated: users.length > TIMESERIES_SCAN_LIMIT,
    keysTruncated: keys.length > TIMESERIES_KEY_SCAN_LIMIT,
  };
}

/** Start of the chart's first bucket for `range`, in the viewer's offset. */
function rangeSince(range: SignupTimeseriesRange, tzOffsetMinutes: number, now: Date): Date {
  const { unit, buckets } = RANGE_SHAPES[range];
  const size = unit === 'hour' ? HOUR_MS : DAY_MS;
  return new Date(truncate(now, unit, tzOffsetMinutes) - (buckets - 1) * size);
}

/**
 * Every signup in [since, now) classified as one cohort. The chart and the Users table's Verdict column
 * both go through here, so an account gets the same verdict in both for the same range.
 */
async function classifyCohort(since: Date, now: Date) {
  const [hourlyCounts, { candidates, truncated, keysTruncated }] = await Promise.all([
    // UTC hours, independent of the viewer's offset, so the spike signal is the same for every viewer.
    countByBucket(new Date(since.getTime() - SPIKE_BASELINE_HOURS * HOUR_MS), now, 'hour', 0),
    loadCandidates(since, now),
  ]);
  return { candidates, signalsById: classifySignups(candidates, now, hourlyCounts), truncated, keysTruncated };
}

/**
 * The chart's verdict for each of `userIds` under `range`; null for an account outside the range, past
 * the classification scan cap, or not found.
 */
export async function getSignupVerdicts(
  {
    range,
    tzOffsetMinutes = 0,
    userIds,
  }: { range: SignupTimeseriesRange; tzOffsetMinutes?: number; userIds: string[] },
  now = new Date()
): Promise<SignupVerdicts> {
  const verdicts: SignupVerdicts['verdicts'] = Object.fromEntries(userIds.map(id => [id, null]));
  const since = rangeSince(range, tzOffsetMinutes, now);
  // A page of old accounts must not pay for classifying the whole range.
  const inRange = await User.exists({ _id: { $in: userIds }, createdAt: { $gte: since, $lt: now } }).maxTimeMS(
    QUERY_DEADLINE_MS
  );
  if (!inRange) return { verdicts };
  const { signalsById } = await classifyCohort(since, now);
  for (const id of userIds) {
    const signals = signalsById.get(id);
    if (signals) verdicts[id] = { suspected: isSuspectedSignup(signals), signals };
  }
  return { verdicts };
}

export async function getSignupTimeseries(
  { range, tzOffsetMinutes = 0 }: { range: SignupTimeseriesRange; tzOffsetMinutes?: number },
  now = new Date()
): Promise<SignupTimeseries> {
  const { unit, buckets: bucketCount, baselineBuckets } = RANGE_SHAPES[range];
  const size = unit === 'hour' ? HOUR_MS : DAY_MS;
  const since = rangeSince(range, tzOffsetMinutes, now);
  const historySince = new Date(since.getTime() - baselineBuckets * size);

  const [counts, { candidates, signalsById, truncated, keysTruncated }] = await Promise.all([
    countByBucket(historySince, now, unit, tzOffsetMinutes),
    classifyCohort(since, now),
  ]);

  const buckets: SignupTimeseriesBucket[] = Array.from({ length: bucketCount }, (_, i) => {
    const start = since.getTime() + i * size;
    const history = Array.from({ length: baselineBuckets }, (_, j) => start - (j + 1) * size)
      .filter(previous => previous >= historySince.getTime())
      .map(previous => counts.get(previous) ?? 0)
      .sort((a, b) => a - b);
    return {
      start: new Date(start).toISOString(),
      total: counts.get(start) ?? 0,
      suspected: 0,
      likelyLegit: 0,
      unclassified: 0,
      bySignal: emptySignalCounts(),
      baseline:
        history.length >= MIN_BASELINE_BUCKETS ? { median: quantile(history, 0.5), p90: quantile(history, 0.9) } : null,
    };
  });
  const indexOf = (date: Date) => Math.floor((truncate(date, unit, tzOffsetMinutes) - since.getTime()) / size);
  const classified = new Array<number>(bucketCount).fill(0);
  for (const candidate of candidates) {
    const index = indexOf(candidate.createdAt);
    const bucket = buckets[index];
    if (!bucket) continue;
    const signals = signalsById.get(candidate.id) ?? [];
    classified[index]++;
    if (isSuspectedSignup(signals)) bucket.suspected++;
    else bucket.likelyLegit++;
    for (const signal of signals) bucket.bySignal[signal]++;
  }
  buckets.forEach((bucket, i) => {
    // The count and the scan are separate reads; a signup landing between them must not go negative.
    bucket.total = Math.max(bucket.total, classified[i]);
    bucket.unclassified = bucket.total - classified[i];
  });

  const totals = { total: 0, suspected: 0, likelyLegit: 0, unclassified: 0, bySignal: emptySignalCounts() };
  for (const bucket of buckets) {
    totals.total += bucket.total;
    totals.suspected += bucket.suspected;
    totals.likelyLegit += bucket.likelyLegit;
    totals.unclassified += bucket.unclassified;
    for (const [signal, count] of Object.entries(bucket.bySignal) as [keyof typeof bucket.bySignal, number][]) {
      totals.bySignal[signal] += count;
    }
  }
  return {
    range,
    bucket: unit,
    since: since.toISOString(),
    until: now.toISOString(),
    buckets,
    totals,
    truncated,
    keysTruncated,
  };
}
