/** Parses a positive integer alarm threshold read from env var `name`; blank falls back to `fallback`. */
export function parseAlarmThreshold(name: string, raw: string | undefined, fallback: number): number;
export function parseAlarmThreshold(name: string, raw: string | undefined): number | undefined;
export function parseAlarmThreshold(name: string, raw: string | undefined, fallback?: number): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer >= 1, got "${raw}"`);
  }
  return value;
}

/** Parses the per-hour signup code send ceiling; undefined means no alarm is configured. */
export function parseSignupCodeSendAlarmThreshold(raw: string | undefined): number | undefined {
  return parseAlarmThreshold('SIGNUP_CODE_SEND_ALARM_PER_HOUR', raw);
}

export const SIGNUP_CODE_SEND_BURST_DEFAULT = 15;
export const API_KEY_CREATE_BURST_DEFAULT = 10;
export const SIGNUP_EDGE_SIGNAL_DEFAULT = 5;
