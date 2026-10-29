import {
  SIGNUP_GRANT_RISK_SIGNALS,
  signupGrantRiskPolicySchema,
  type SignupGrantRiskPolicy,
  type SignupGrantRiskSignal,
} from '@bike4mind/common';

export const SIGNUP_RISK_SIGNALS = SIGNUP_GRANT_RISK_SIGNALS;
export const signupRiskPolicySchema = signupGrantRiskPolicySchema;
export type SignupRiskPolicy = SignupGrantRiskPolicy;
export type SignupRiskSignal = SignupGrantRiskSignal;
export type SignupRiskSignals = Partial<Record<SignupRiskSignal, boolean | number | null>>;
export type SignupRiskBand = 'full' | 'reduced' | 'review';

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
