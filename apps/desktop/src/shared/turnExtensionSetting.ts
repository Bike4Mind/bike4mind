/**
 * How many times a turn that hit its round or time budget while still making progress is carried
 * on automatically, from Settings ("Extra turns for long tasks"). Zero always stops at the budget.
 *
 * Three by default: each extension is another full budget of rounds or wall clock spent on the
 * user's credits, so the cap is modest. A stalled turn (see TurnLimits.stalledRounds) is never
 * extended whatever this says. Must stay in sync with the Settings choices in
 * renderer/src/chat/TurnExtensionsSettings.tsx, which reads MIN/MAX from here.
 */
export const DEFAULT_TURN_EXTENSIONS = 3;
export const MIN_TURN_EXTENSIONS = 0;
export const MAX_TURN_EXTENSIONS = 10;

/** Anything but a whole number in range reads as the default. */
export function parseTurnExtensions(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_TURN_EXTENSIONS &&
    value <= MAX_TURN_EXTENSIONS
    ? value
    : DEFAULT_TURN_EXTENSIONS;
}
