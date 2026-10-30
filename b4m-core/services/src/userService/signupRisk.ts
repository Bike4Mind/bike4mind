import type { IUserDocument, SignupGrant } from '@bike4mind/common';
import { z } from 'zod';

export const SIGNUP_RISK_SIGNALS = [
  'datacenter',
  'canonicalEmailCollision',
  'disposableDomain',
  'blockedDomain',
  'challengeVerified',
  'ipSignups',
  'asnSignups',
  'prefixSignups',
] as const;

export type SignupRiskSignal = (typeof SIGNUP_RISK_SIGNALS)[number];
export type SignupRiskSignals = Partial<Record<SignupRiskSignal, boolean | number | null>>;
export type SignupRiskBand = 'full' | 'reduced' | 'review';

const finiteNonnegative = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const ruleSchema = z
  .object({
    signal: z.enum(SIGNUP_RISK_SIGNALS),
    comparison: z.enum(['eq', 'gte']),
    threshold: finiteNonnegative,
    weight: finiteNonnegative,
    missing: z.enum(['review', 'score']),
    missingWeight: finiteNonnegative,
  })
  .strict()
  .superRefine((rule, ctx) => {
    const countSignal = rule.signal.endsWith('Signups');
    if (
      (countSignal && !Number.isSafeInteger(rule.threshold)) ||
      (!countSignal && (rule.comparison !== 'eq' || (rule.threshold !== 0 && rule.threshold !== 1)))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid signal comparison' });
    }
  });

export const signupRiskPolicySchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      version: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      rules: z.array(ruleSchema).min(1).max(SIGNUP_RISK_SIGNALS.length),
      reducedAt: finiteNonnegative.positive(),
      reviewAt: finiteNonnegative.positive(),
      reducedFraction: z.number().finite().gt(0).lt(1),
    })
    .strict()
    .superRefine((policy, ctx) => {
      if (policy.reviewAt <= policy.reducedAt) {
        ctx.addIssue({ code: 'custom', message: 'Bands must be strictly ordered' });
      }
      if (new Set(policy.rules.map(rule => rule.signal)).size !== policy.rules.length) {
        ctx.addIssue({ code: 'custom', message: 'Signals must be unique' });
      }
      const maximumScore = policy.rules.reduce((sum, rule) => sum + Math.max(rule.weight, rule.missingWeight), 0);
      if (!Number.isSafeInteger(Math.ceil(maximumScore))) {
        ctx.addIssue({ code: 'custom', message: 'Score exceeds numeric bounds' });
      }
    }),
]);

export type SignupRiskPolicy = z.infer<typeof signupRiskPolicySchema>;
export type SignupRiskDecision = {
  band: SignupRiskBand;
  credits: number;
  score: number | null;
  reasons: SignupRiskSignal[];
  missing: SignupRiskSignal[];
  policyVersion: string | null;
  status: 'evaluated' | 'disabled' | 'unavailable';
};

const reviewDecision = (): SignupRiskDecision => ({
  band: 'review',
  credits: 0,
  score: null,
  reasons: [],
  missing: [],
  policyVersion: null,
  status: 'unavailable',
});

/** Inputs are server observations, not request-body fields. No policy values are supplied by default. */
export function evaluateSignupRisk(
  rawPolicy: unknown,
  signals: SignupRiskSignals,
  signupCredits: number
): SignupRiskDecision {
  if (!Number.isSafeInteger(signupCredits) || signupCredits < 0) throw new Error('Invalid signup entitlement');
  const parsed = signupRiskPolicySchema.safeParse(rawPolicy);
  if (!parsed.success) return reviewDecision();
  const policy = parsed.data;
  if (!policy.enabled) {
    return { ...reviewDecision(), band: 'full', credits: signupCredits, status: 'disabled' };
  }

  let score = 0;
  let needsReview = false;
  const reasons: SignupRiskSignal[] = [];
  const missing: SignupRiskSignal[] = [];
  for (const rule of policy.rules) {
    const observed = signals[rule.signal];
    const booleanSignal = !rule.signal.endsWith('Signups');
    const valid = booleanSignal
      ? typeof observed === 'boolean'
      : typeof observed === 'number' && Number.isSafeInteger(observed) && observed >= 0;
    if (!valid) {
      missing.push(rule.signal);
      needsReview ||= rule.missing === 'review';
      score += rule.missingWeight;
    } else if (rule.comparison === 'eq' ? Number(observed) === rule.threshold : Number(observed) >= rule.threshold) {
      score += rule.weight;
      reasons.push(rule.signal);
    }
  }
  const band = needsReview || score >= policy.reviewAt ? 'review' : score >= policy.reducedAt ? 'reduced' : 'full';
  const credits =
    band === 'review' ? 0 : band === 'full' ? signupCredits : Math.floor(signupCredits * policy.reducedFraction);
  return { band, credits, score, reasons, missing, policyVersion: policy.version, status: 'evaluated' };
}

export type SignupRiskCommitResult = {
  decision: SignupRiskDecision;
  applied: boolean;
};

export type SignupRiskAdapters = {
  readPolicy: () => Promise<unknown>;
  collectSignals: () => Promise<SignupRiskSignals>;
  // The staged-grant owner commits audit + entitlement + ledger/balance atomically and returns the winner on retry.
  commit: (decision: SignupRiskDecision) => Promise<SignupRiskCommitResult>;
  emitBand: (band: SignupRiskBand) => Promise<void>;
};

/** For new staged accounts only; callers retain existing-account, paid and staff exemptions. */
export async function assessSignupGrant(
  signupCredits: number,
  adapters: SignupRiskAdapters
): Promise<SignupRiskCommitResult> {
  let policy: unknown;
  let signals: SignupRiskSignals = {};
  try {
    policy = await adapters.readPolicy();
    const parsed = signupRiskPolicySchema.safeParse(policy);
    if (parsed.success && parsed.data.enabled) signals = await adapters.collectSignals();
  } catch {
    policy = undefined;
  }
  const decision = evaluateSignupRisk(policy, signals, signupCredits);
  if (decision.status === 'unavailable') {
    console.warn('[signup-risk] Assessment unavailable; holding signup grant');
  }
  const result = await adapters.commit(decision);
  if (result.applied) {
    // Telemetry must not turn a committed grant into an authentication failure.
    try {
      await adapters.emitBand(result.decision.band);
    } catch {
      console.warn('[signup-risk] Band telemetry failed after grant commit');
    }
  }
  return result;
}

/**
 * The signup tranche was withheld in the review band and is still unpaid, so the account waits on
 * the admin risk review queue (refreshSignupRiskScore), whose approval releases it.
 */
export function isSignupGrantHeldForReview(
  user: Pick<IUserDocument, 'signupGrant' | 'signupGrantAssessment'>
): user is typeof user & { signupGrant: SignupGrant } {
  const grant = user.signupGrant;
  return (
    user.signupGrantAssessment?.band === 'review' &&
    grant?.stage === 'signup' &&
    grant.creditsReleased < grant.signupCredits
  );
}
