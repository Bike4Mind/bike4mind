import { adminSettingsRepository, User, UserApiKey } from '@bike4mind/database';
import {
  hasDeveloperUserTag,
  INTERNAL_ACCOUNT_FLAGS,
  internalStaffEmailRegex,
  isSyntheticIdentity,
  parseInternalStaffDomains,
  parseSyntheticDomainList,
} from '@bike4mind/common';
import { aiAccessDeniedMessage } from '@bike4mind/services/userService/accountState';
import type { SignupSignal } from '@client/app/utils/signupSignals';
import {
  classifySignups,
  SPIKE_BASELINE_HOURS,
  type SignupCandidate,
} from '../users/signupClassifier';
import { countByBucket, loadCandidates } from '../users/signupTimeseries';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const USER_BATCH = 1000;
const OBJECT_ID = /^[a-f\d]{24}$/i;

export type UserFlags = {
  _id: unknown;
  email?: string;
  createdAt?: Date;
  isAdmin?: boolean;
  isSystem?: boolean;
  isSynthetic?: boolean;
  username?: string;
  tags?: string[];
  emailVerified?: boolean;
  isBanned?: boolean;
  isModerated?: boolean;
  disputePending?: boolean;
  moderation?: { status?: string | null } | null;
  riskScore?: { reviewState?: string | null } | null;
};

export const USER_FLAG_FIELDS =
  '_id email createdAt isAdmin isSystem isSynthetic username tags emailVerified isBanned isModerated disputePending moderation.status riskScore.reviewState';

/** What the eligibility predicates need, read once per run. */
export type CountingContext = { staffRegex: RegExp | null; testDomains: readonly string[] };

/**
 * Internal accounts are never counted: admin, system, synthetic, staff-domain, Developer-tagged and e2e
 * personas. Orphaned and non-ObjectId ids still count, so DAU matches a direct distinct count over usageevents.
 */
export const isCountedUser = (user: UserFlags | undefined, { staffRegex, testDomains }: CountingContext): boolean =>
  !user ||
  !(
    INTERNAL_ACCOUNT_FLAGS.some(flag => user[flag]) ||
    (staffRegex && user.email && staffRegex.test(user.email)) ||
    hasDeveloperUserTag(user.tags) ||
    isSyntheticIdentity(user, testDomains)
  );

/**
 * Counted, and not banned or AI-held (aiAccessDeniedMessage is the platform's one gate for that), so an
 * account that cannot use the product is neither an active user nor a real signup.
 */
export const isActiveEligible = (user: UserFlags | undefined, ctx: CountingContext): boolean =>
  isCountedUser(user, ctx) && (!user || aiAccessDeniedMessage(user) === null);

export async function loadCountingContext(): Promise<CountingContext> {
  let testDomains: string[] = [];
  try {
    testDomains = parseSyntheticDomainList(await adminSettingsRepository.getSettingsValue('syntheticUserEmailDomains'));
  } catch {
    // A failed settings read leaves the e2e domain rule off rather than failing the rollup.
  }
  return {
    staffRegex: internalStaffEmailRegex(parseInternalStaffDomains(process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS)),
    testDomains,
  };
}

/** The fields isCountedUser reads, for the ids that are ObjectIds. */
export async function loadUserFlags(userIds: string[], deadlineMs: number): Promise<Map<string, UserFlags>> {
  const valid = userIds.filter(id => OBJECT_ID.test(id));
  const users = new Map<string, UserFlags>();
  for (let i = 0; i < valid.length; i += USER_BATCH) {
    const rows = await User.find({ _id: { $in: valid.slice(i, i + USER_BATCH) } })
      .select(USER_FLAG_FIELDS)
      .maxTimeMS(deadlineMs)
      .lean<UserFlags[]>();
    for (const row of rows) users.set(String(row._id), row);
  }
  return users;
}

type ApiActivity = { firstApiKeyAt: Date; lastApiUseAt: Date | null };

async function loadApiActivity(userIds: string[], deadlineMs: number): Promise<Map<string, ApiActivity>> {
  const activity = new Map<string, ApiActivity>();
  for (let i = 0; i < userIds.length; i += USER_BATCH) {
    // A returning API user may have created their active key long after the signup cohort window.
    const rows = await UserApiKey.aggregate<{ _id: string } & ApiActivity>([
      { $match: { userId: { $in: userIds.slice(i, i + USER_BATCH) } } },
      { $group: { _id: '$userId', firstApiKeyAt: { $min: '$createdAt' }, lastApiUseAt: { $max: '$lastUsedAt' } } },
    ]).option({ maxTimeMS: deadlineMs });
    for (const row of rows) activity.set(row._id, row);
  }
  return activity;
}

export type SignupWindowCohort = {
  /** Counted accounts created in [start, end) that the candidate scan reached. */
  counted: SignupCandidate[];
  signalsById: Map<string, SignupSignal[]>;
  /** The scan hit its cap, so some accounts in the window were never classified. */
  truncated: boolean;
};

/**
 * Classifies the counted accounts created in [start, end) as one cohort. The nightly rollup (one UTC day)
 * and the users list's verdict filter (a chart bucket) both classify through here.
 */
export async function classifySignupWindow(
  start: Date,
  end: Date,
  { now, deadlineMs }: { now: Date; deadlineMs: number }
): Promise<SignupWindowCohort> {
  // A one-day margin each side lets cohort signals (bursts, shared network) see accounts across the edges.
  const scanSince = new Date(start.getTime() - DAY_MS);
  const scanUntil = new Date(end.getTime() + DAY_MS);
  const [{ candidates, truncated }, hourlyCounts] = await Promise.all([
    loadCandidates(scanSince, scanUntil, deadlineMs),
    // UTC hours, same baseline window as getSignupTimeseries, so the spike signal agrees with the live view.
    countByBucket(new Date(scanSince.getTime() - SPIKE_BASELINE_HOURS * HOUR_MS), scanUntil, 'hour', 0, deadlineMs),
  ]);

  const inWindow = candidates.filter(c => c.createdAt >= start && c.createdAt < end);
  const ctx = await loadCountingContext();
  const users = await loadUserFlags(
    inWindow.map(c => c.id),
    deadlineMs
  );
  const counted = inWindow.filter(c => isCountedUser(users.get(c.id), ctx));
  const apiActivity = await loadApiActivity(
    counted.map(c => c.id),
    deadlineMs
  );
  const signalsById = classifySignups(
    candidates.map(candidate => ({ ...candidate, ...apiActivity.get(candidate.id) })),
    now,
    hourlyCounts
  );
  return { counted, signalsById, truncated };
}
