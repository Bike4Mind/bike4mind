/**
 * Selection rules for the gated E2E cleanup endpoint (pages/api/test/cleanup.ts).
 * Kept out of the route module so they can be unit-tested without Next/SST/Mongo.
 * Must stay in sync with the client-side id handling in e2e/helpers/test-users.ts
 * (getE2ETestId) - both strip the same character class.
 */

// Only sweep EPHEMERAL test users, which always carry a numeric timestamp segment
// (e.g. setup-admin-12345678-e2e@test.com - see e2e/core.setup.ts + apiCreateTestUser).
// Standing seeded QA accounts (qa-admin-e2e@test.com / qa-user-e2e@test.com from
// UserSeeder) deliberately omit the timestamp so this cleanup never deletes them -
// otherwise every Playwright/CI run would wipe the accounts QA logs in with.
export const BASE_E2E_EMAIL_PATTERN = /-\d+-e2e@test\.com$/i;

// Floor for the aged sweep. Must stay well above the longest allowed run (ai-latency
// matrix cells get 90 min) so an in-flight suite's users can never fall in range.
// Age comes from the User doc's createdAt, NOT from the email: the digits in the email
// tail are a truncated clock (core.setup.ts uses Date.now().slice(-8), other specs
// slice(-6)), so they are unique-ish but say nothing about absolute age.
export const MIN_STALE_SWEEP_MINUTES = 120;
export const DEFAULT_STALE_SWEEP_MINUTES = 360;

export function sanitizeTestId(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[^a-zA-Z0-9]/g, '') : '';
}

/**
 * Scoped pattern for a single run's users. Anchored on the leading '-' so one testId can
 * never match a longer one that merely ends with it (e.g. 'gh12' vs 'alicegh12'). Falls
 * back to the unscoped base pattern only when no testId is supplied (local dev).
 */
export function buildE2EEmailPattern(testId: string): RegExp {
  return testId ? new RegExp(`-${testId}-[0-9]+-e2e@test\\.com$`, 'i') : BASE_E2E_EMAIL_PATTERN;
}

/**
 * Clamps a caller-supplied window up to the floor, so `staleMinutes=0` can never turn the
 * aged sweep back into the delete-every-e2e-user sweep that used to break concurrent runs.
 */
export function resolveStaleSweepMinutes(raw: unknown): number {
  const requested = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(requested)) return DEFAULT_STALE_SWEEP_MINUTES;
  return Math.max(requested, MIN_STALE_SWEEP_MINUTES);
}
