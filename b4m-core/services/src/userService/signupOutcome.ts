import type { IUserDocument } from '@bike4mind/common';
import { isSignupGrantHeldForReview } from './signupRisk';

/** How long a new account has to make its first AI request before it can count as a real signup. */
export const SIGNUP_ACTIVATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `undecided` means the activation window is still open with no request yet, so the account cannot be
 * labeled either way. Callers must leave it out of calibration rather than count it as suspected.
 */
export type SignupOutcome = 'legitimate' | 'suspected' | 'undecided';

export type SignupOutcomeUser = Pick<
  IUserDocument,
  | 'createdAt'
  | 'emailVerified'
  | 'isBanned'
  | 'isModerated'
  | 'signupGrant'
  | 'signupGrantAssessment'
  | 'signupGrantHeldReason'
  | 'riskScore'
>;

const heldBySignupReview = (user: SignupOutcomeUser): boolean =>
  isSignupGrantHeldForReview(user) ||
  user.signupGrantHeldReason === 'risk_review' ||
  user.riskScore?.reviewState === 'pending';

/**
 * The product's target label for calibrating the signup risk score: a real signup has a
 * verified email; is not banned, moderated or held by signup review; and made at least one successful
 * AI request within 7 days of signup. Everything else is suspected. The signup analytics dashboard's
 * heuristic `signupVerdictOf` is a different classifier, so calibrate against this one, not that.
 *
 * `firstAiRequestAt` is the earliest successful AI request inside the activation window, or null when
 * there is none; a request outside the window must not be passed in.
 */
export function classifySignupOutcome(
  user: SignupOutcomeUser,
  firstAiRequestAt: Date | null,
  now: Date
): SignupOutcome {
  const signedUpAt = new Date(user.createdAt).getTime();
  if (!Number.isFinite(signedUpAt)) throw new Error('Signup outcome needs a valid signup time');
  if (user.isBanned || user.isModerated || heldBySignupReview(user)) return 'suspected';
  if (user.emailVerified === true && firstAiRequestAt) return 'legitimate';
  // An account can still verify its email or make its first request until the window closes.
  return now.getTime() < signedUpAt + SIGNUP_ACTIVATION_WINDOW_MS ? 'undecided' : 'suspected';
}
