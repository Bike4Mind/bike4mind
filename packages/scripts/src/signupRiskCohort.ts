import { INTERNAL_ACCOUNT_FLAGS } from '@bike4mind/common';
import { UsageEvent, User } from '@bike4mind/database';
import { userService } from '@bike4mind/services';

/** Must match replaySignupRisk's sample cap, so every file this writes is one the replay accepts. */
export const MAX_COHORT_SAMPLES = 100_000;

export type CohortSample = {
  cohort: 'suspected' | 'legitimate';
  signupCredits: number;
  signals: userService.SignupRiskSignals;
};

export type CohortSkips = {
  /** Assessed before signal values were recorded, so there is nothing to replay. */
  noRecordedSignals: number;
  /** The 7-day activation window is still open with no verdict yet. */
  undecided: number;
  /** Staff-domain accounts; admin, system and synthetic accounts are excluded in the query. */
  internal: number;
};

export type SignupRiskCohort = { samples: CohortSample[]; skipped: CohortSkips };

type CohortUser = userService.SignupOutcomeUser & { _id: unknown; email?: string };

const SIGNAL_NAMES = new Set<string>(userService.SIGNUP_RISK_SIGNALS);

/** Keeps only known signals with replayable values, so a stray key cannot fail the replay's strict schema. */
export function replayableSignals(recorded: unknown): userService.SignupRiskSignals | null {
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) return null;
  const signals: Record<string, boolean | number | null> = {};
  for (const [name, value] of Object.entries(recorded)) {
    if (!SIGNAL_NAMES.has(name)) continue;
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      signals[name] = value;
    }
  }
  return signals as userService.SignupRiskSignals;
}

async function firstAiRequestAt(userId: string, signedUpAt: Date): Promise<Date | null> {
  const windowEnd = new Date(signedUpAt.getTime() + userService.SIGNUP_ACTIVATION_WINDOW_MS);
  const event = await UsageEvent.findOne({ userId, status: 'ok', createdAt: { $gte: signedUpAt, $lt: windowEnd } })
    .sort({ createdAt: 1 })
    .select('createdAt')
    .lean<{ createdAt: Date } | null>();
  return event?.createdAt ?? null;
}

/**
 * Labels signups in [since, until) with the product's real-signup definition (classifySignupOutcome) and
 * pairs each label with the signal values recorded at grant time. Read-only. The samples carry no
 * identifiers, so the output is safe to hand to replaySignupRisk without exposing accounts.
 */
export async function buildSignupRiskCohort(options: {
  since: Date;
  until: Date;
  now: Date;
  staffRegex: RegExp | null;
}): Promise<SignupRiskCohort> {
  const { since, until, now, staffRegex } = options;
  const skipped: CohortSkips = { noRecordedSignals: 0, undecided: 0, internal: 0 };
  const samples: CohortSample[] = [];
  const cursor = User.find({
    createdAt: { $gte: since, $lt: until },
    'signupGrant.signupCredits': { $exists: true },
    'signupGrantAssessment.status': { $exists: true },
    ...Object.fromEntries(INTERNAL_ACCOUNT_FLAGS.map(flag => [flag, { $ne: true }])),
  })
    .select(
      '_id email createdAt emailVerified isBanned isModerated signupGrant signupGrantAssessment signupGrantHeldReason riskScore'
    )
    .sort({ createdAt: 1 })
    .lean<CohortUser[]>()
    .cursor();

  for await (const user of cursor) {
    if (staffRegex && user.email && staffRegex.test(user.email)) {
      skipped.internal += 1;
      continue;
    }
    const signals = replayableSignals(user.signupGrantAssessment?.signals);
    const signupCredits = user.signupGrant?.signupCredits;
    if (!signals || !Number.isSafeInteger(signupCredits) || signupCredits === undefined || signupCredits < 0) {
      skipped.noRecordedSignals += 1;
      continue;
    }
    const signedUpAt = new Date(user.createdAt);
    const outcome = userService.classifySignupOutcome(user, await firstAiRequestAt(String(user._id), signedUpAt), now);
    if (outcome === 'undecided') {
      skipped.undecided += 1;
      continue;
    }
    if (samples.length >= MAX_COHORT_SAMPLES) {
      throw new Error(`More than ${MAX_COHORT_SAMPLES} labeled signups; narrow --since/--until`);
    }
    samples.push({ cohort: outcome, signupCredits, signals });
  }
  return { samples, skipped };
}
