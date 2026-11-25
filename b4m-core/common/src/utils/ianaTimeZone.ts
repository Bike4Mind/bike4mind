/**
 * True for a time zone name the runtime's Intl data recognizes (`America/New_York`, `UTC`). Rejects bare
 * UTC offsets (`+05:30`), which newer engines accept but which carry no DST rules.
 */
export function isValidIanaTimeZone(timeZone: string): boolean {
  if (!timeZone || /^[+-]/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
