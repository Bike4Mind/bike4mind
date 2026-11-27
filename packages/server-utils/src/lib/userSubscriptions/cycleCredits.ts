/** The persisted override wins; invalid values must not fall back to a different grant. */
export function resolveSubscriptionCycleCredits(
  planCredits: number | undefined,
  customCreditsPerCycle?: number
): number | null {
  const credits = customCreditsPerCycle ?? planCredits;
  return typeof credits === 'number' && Number.isFinite(credits) && credits > 0 ? credits : null;
}
