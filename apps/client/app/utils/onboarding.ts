/**
 * First-run / onboarding helpers, extracted as pure functions so the branchy logic in
 * `ModalManager` (brand-new-account grace) and `EmailVerificationBanner` (nag cadence)
 * is unit-testable and lives in one place instead of inline in effect bodies.
 */

/** Window during which a freshly created account is treated as "brand new". */
export const NEW_ACCOUNT_GRACE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * True when the account was created within the grace window, used to give brand-new users a clean
 * first run (no "What's New" changelog of releases that predate them). When `createdAt` is absent
 * or unparseable this returns false, which is correct: an account with no usable createdAt is not
 * treated as brand-new (it has already lived past its first in-memory session).
 */
export function isBrandNewAccount(
  createdAt: Date | string | number | null | undefined,
  now: number = Date.now(),
  graceMs: number = NEW_ACCOUNT_GRACE_MS
): boolean {
  if (!createdAt) return false;
  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs) || createdMs <= 0) return false;
  return now - createdMs < graceMs;
}

/** Interval between email-verification nags after a dismissal. */
export const EMAIL_VERIFICATION_NAG_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** localStorage key tracking the last dismissal timestamp (24h nag interval). */
export const EMAIL_VERIFICATION_DISMISSED_KEY = 'b4m_email_verification_dismissed_at';

/** localStorage key for permanent "don't show again" suppression. */
export const EMAIL_VERIFICATION_PERMANENT_DISMISS_KEY = 'b4m_email_verification_permanent_dismiss';

/**
 * True when the persistent email-verification nag should show, given the last dismissal timestamp
 * (as stored in localStorage). No prior dismissal: show; within the interval: suppress; past it:
 * show again. A malformed stored value is treated as "no dismissal" (show - naggy is acceptable).
 */
export function shouldShowVerificationNag(
  dismissedAtRaw: string | null,
  now: number = Date.now(),
  nagIntervalMs: number = EMAIL_VERIFICATION_NAG_INTERVAL_MS
): boolean {
  if (!dismissedAtRaw) return true;
  const dismissedAt = parseInt(dismissedAtRaw, 10);
  if (!Number.isFinite(dismissedAt)) return true;
  return now - dismissedAt >= nagIntervalMs;
}
