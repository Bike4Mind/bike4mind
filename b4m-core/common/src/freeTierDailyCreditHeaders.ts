/**
 * The headers the free-tier daily credit cap sets for a Free-tier caller, keyed by name with the
 * description the public docs publish. Single source for the cap gate
 * (packages/server-utils/src/billing/freeTierDailyCapGate.ts) and the API docs. Renaming a key
 * renames a production response header.
 */
export const FREE_TIER_DAILY_CREDIT_HEADERS = Object.freeze({
  'X-Daily-Credits-Limit': 'Credits a Free-tier account may spend today, after the account-age ramp.',
  'X-Daily-Credits-Remaining':
    "Credits left today, measured before this request ran, so it overstates what is left by this request's cost.",
  'X-Daily-Credits-Reset': 'Unix epoch (seconds) of the next UTC midnight, when the allowance resets.',
} as const);

export type FreeTierDailyCreditHeader = keyof typeof FREE_TIER_DAILY_CREDIT_HEADERS;

export const FREE_TIER_DAILY_CREDIT_HEADER_NAMES = Object.freeze(
  Object.keys(FREE_TIER_DAILY_CREDIT_HEADERS) as FreeTierDailyCreditHeader[]
);

/** Today's credit allowance for a Free-tier caller, as the cap gate measured it before the turn. */
export interface FreeTierDailyAllowance {
  limitCredits: number;
  remainingCredits: number;
  resetAt: Date;
}

/** Header values for FREE_TIER_DAILY_CREDIT_HEADERS. */
export function freeTierDailyCreditHeaderValues(
  allowance: FreeTierDailyAllowance
): Record<FreeTierDailyCreditHeader, number> {
  return {
    'X-Daily-Credits-Limit': allowance.limitCredits,
    'X-Daily-Credits-Remaining': allowance.remainingCredits,
    'X-Daily-Credits-Reset': Math.floor(allowance.resetAt.getTime() / 1000),
  };
}

/** Set the allowance headers on a response; a no-op when the cap did not apply to the caller. */
export function setFreeTierDailyCreditHeaders(
  res: { setHeader(name: string, value: number | string): unknown },
  allowance: FreeTierDailyAllowance | undefined
): void {
  if (!allowance) return;
  for (const [name, value] of Object.entries(freeTierDailyCreditHeaderValues(allowance))) res.setHeader(name, value);
}
