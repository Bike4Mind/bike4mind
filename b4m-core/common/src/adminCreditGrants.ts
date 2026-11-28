/**
 * Admin credit grant limits, per recipient over a rolling 24 hours and summed across every admin. Any admin
 * who can grant credits grants up to ADMIN_GRANT_IMMEDIATE_LIMIT at once; above it the whole grant becomes one
 * approval request. A listed approver (apps/client/server/admin/creditGrants/seniorGranters.ts) grants others
 * up to ADMIN_GRANT_HARD_LIMIT at once, and no grant, approved or not, goes past it except a subscription
 * grant. Enforced by apps/client/server/admin/creditGrants/tierCap.ts.
 */
export const ADMIN_GRANT_IMMEDIATE_LIMIT = 100_000;
export const ADMIN_GRANT_HARD_LIMIT = 500_000;
/** The rolling window both limits apply over, in ms. */
export const ADMIN_GRANT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Typed to take a recipient past ADMIN_GRANT_IMMEDIATE_LIMIT, whether the grant then runs or goes for approval;
 * the request then carries `confirmLargeGrant` and a reason.
 */
export const ADMIN_LARGE_GRANT_PHRASE = 'I UNDERSTAND';

/** Fixed display rate for grant dialogs, deliberately not live pricing. */
export const ADMIN_GRANT_USD_PER_10K_CREDITS = 6;

const usdFormat = (fractionDigits: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
const WHOLE_USD = usdFormat(0);
const CENTS_USD = usdFormat(2);

/**
 * "$60", "$3,000" or "$1.50": whole dollars drop the cents, anything else is rounded to cents. A grant
 * too small to reach a cent reads "less than $0.01", so a real grant never shows as "$0".
 */
export function creditsToUsd(credits: number): string {
  const cents = Math.round((credits * ADMIN_GRANT_USD_PER_10K_CREDITS * 100) / 10_000);
  if (cents === 0 && credits > 0) return `less than ${CENTS_USD.format(0.01)}`;
  return cents % 100 === 0 ? WHOLE_USD.format(cents / 100) : CENTS_USD.format(cents / 100);
}

/** The `code` on a grant-cap refusal (tierCap.ts), whose body also carries the AdminGrantLimitRefusal fields. */
export const ADMIN_GRANT_LIMIT_ERROR_CODE = 'admin_grant_limit';

export type AdminGrantLimitRefusal = {
  code: typeof ADMIN_GRANT_LIMIT_ERROR_CODE;
  /** Whose 24-hour total the grant would exceed: the user, or the organization a team grant funds. */
  subject: 'user' | 'organization';
  /**
   * `hard_limit`: past ADMIN_GRANT_HARD_LIMIT, which approval cannot lift. `confirmation_required`: past
   * ADMIN_GRANT_IMMEDIATE_LIMIT without the typed phrase and a reason. `approval_unavailable`: past what the
   * admin may grant at once, on a path that cannot ask for approval (bulk adjust, or a balance that moved).
   */
  reason: 'hard_limit' | 'confirmation_required' | 'approval_unavailable';
  receivedCredits: number;
  /** What this admin may still grant the subject without crossing the limit that refused this grant. */
  remainingCredits: number;
};

/** Whether an error response body is a grant-cap refusal (tierCap.ts). */
export function isGrantLimitRefusal(body: unknown): body is AdminGrantLimitRefusal {
  return !!body && typeof body === 'object' && (body as { code?: unknown }).code === ADMIN_GRANT_LIMIT_ERROR_CODE;
}

/**
 * What an admin may still grant a recipient who has `receivedCredits` in the window: `immediate` at once,
 * `unconfirmed` before the typed phrase is needed, `hard` before ADMIN_GRANT_HARD_LIMIT. Grant dialogs use it
 * with the server's figures (adminRecentCreditGrantsSchema); tierCap.ts applies the same limits.
 */
export function adminGrantRoom({
  receivedCredits,
  immediateLimit,
}: {
  receivedCredits: number;
  immediateLimit: number;
}) {
  return {
    immediate: Math.max(0, immediateLimit - receivedCredits),
    unconfirmed: Math.max(0, ADMIN_GRANT_IMMEDIATE_LIMIT - receivedCredits),
    hard: Math.max(0, ADMIN_GRANT_HARD_LIMIT - receivedCredits),
  };
}
