/**
 * Auto-fix turns a PR gets each time its box is ticked, from Settings.
 *
 * Five by default: a fix often uncovers the next failure, so the first few turns are spent
 * converging. Each is a full agent turn spending the user's credits with nobody watching, and a
 * problem that five attempts have not moved usually needs a person, not a sixth guess. Capped so
 * a typo cannot leave one PR spending credits all night.
 */
export const DEFAULT_AUTO_FIX_ATTEMPTS = 5;
export const MIN_AUTO_FIX_ATTEMPTS = 1;
export const MAX_AUTO_FIX_ATTEMPTS = 20;

/** Anything but a whole number in range reads as the default. */
export function parseAutoFixAttempts(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_AUTO_FIX_ATTEMPTS &&
    value <= MAX_AUTO_FIX_ATTEMPTS
    ? value
    : DEFAULT_AUTO_FIX_ATTEMPTS;
}
