import { UsageEvent, User } from '@bike4mind/database';
import {
  isActiveEligible,
  isCountedUser,
  loadCountingContext,
  USER_FLAG_FIELDS,
  type CountingContext,
  type UserFlags,
} from './signupCohort';

const DAY_MS = 24 * 60 * 60 * 1000;
const USER_BATCH = 1000;

/**
 * Days after account creation in which an AI request makes a signup real: exactly 7x24h from createdAt.
 * ACTIVATION_WINDOW_DAYS (activationFunnel.ts) is the same number but counts UTC days, so the two differ.
 */
export const REAL_SIGNUP_WINDOW_DAYS = 7;

export type RealSignupVerdict = 'legit' | 'suspected';

/**
 * A signup is real when the email is verified, the account is not banned or AI-held, and it made a
 * successful non-system AI request within REAL_SIGNUP_WINDOW_DAYS of creating the account. Anything
 * else is suspected; there is no undecided bucket.
 */
export function realSignupVerdictOf(
  user: UserFlags & { createdAt: Date },
  firstRequestAt: Date | undefined,
  ctx: CountingContext
): RealSignupVerdict {
  const windowEnd = user.createdAt.getTime() + REAL_SIGNUP_WINDOW_DAYS * DAY_MS;
  return canBeReal(user, ctx) && firstRequestAt !== undefined && firstRequestAt.getTime() < windowEnd
    ? 'legit'
    : 'suspected';
}

const canBeReal = (user: UserFlags, ctx: CountingContext) => user.emailVerified === true && isActiveEligible(user, ctx);

export type RealSignupCohort = { legitIds: string[]; suspectedIds: string[] };

/**
 * Splits the counted accounts created in [start, end) into real and suspected. Reads the cohort straight
 * from User in _id batches with no cap, so the split is exact for any window size. The nightly rollup and the
 * users list's verdict filter both decide here.
 */
export async function classifyRealSignups(
  start: Date,
  end: Date,
  { deadlineMs, ctx }: { deadlineMs: number; ctx?: CountingContext }
): Promise<RealSignupCohort> {
  const counting = ctx ?? (await loadCountingContext());
  const legitIds: string[] = [];
  const suspectedIds: string[] = [];
  let after: unknown;
  for (;;) {
    const batch = await User.find({ createdAt: { $gte: start, $lt: end }, ...(after ? { _id: { $gt: after } } : {}) })
      .sort({ _id: 1 })
      .limit(USER_BATCH)
      .select(USER_FLAG_FIELDS)
      .maxTimeMS(deadlineMs)
      .lean<(UserFlags & { createdAt: Date })[]>();
    if (batch.length === 0) break;
    after = batch[batch.length - 1]._id;

    const counted = batch.filter(user => isCountedUser(user, counting));
    // Only an eligible account can be real, so skip the usage lookup for the rest.
    const candidates = counted.filter(user => canBeReal(user, counting)).map(user => String(user._id));
    const firstRequest = new Map<string, Date>();
    if (candidates.length > 0) {
      const rows = await UsageEvent.aggregate<{ _id: string; first: Date }>([
        {
          $match: {
            userId: { $in: candidates },
            status: 'ok',
            source: { $ne: 'system' },
            createdAt: { $gte: start, $lt: new Date(end.getTime() + REAL_SIGNUP_WINDOW_DAYS * DAY_MS) },
          },
        },
        { $group: { _id: '$userId', first: { $min: '$createdAt' } } },
      ]).option({ maxTimeMS: deadlineMs });
      for (const row of rows) firstRequest.set(row._id, row.first);
    }
    for (const user of counted) {
      const id = String(user._id);
      (realSignupVerdictOf(user, firstRequest.get(id), counting) === 'legit' ? legitIds : suspectedIds).push(id);
    }
    if (batch.length < USER_BATCH) break;
  }
  return { legitIds, suspectedIds };
}

/** Ids of the counted accounts created in [start, end) whose real-signup verdict is `verdict`. */
export async function signupVerdictUserIds(
  { start, end, verdict }: { start: Date; end: Date; verdict: RealSignupVerdict },
  { deadlineMs }: { deadlineMs: number }
): Promise<string[]> {
  const { legitIds, suspectedIds } = await classifyRealSignups(start, end, { deadlineMs });
  return verdict === 'legit' ? legitIds : suspectedIds;
}
