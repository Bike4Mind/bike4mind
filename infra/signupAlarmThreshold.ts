/** Parses the per-hour signup code send ceiling; undefined means no alarm is configured. */
export function parseSignupCodeSendAlarmThreshold(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`SIGNUP_CODE_SEND_ALARM_PER_HOUR must be an integer >= 1, got "${raw}"`);
  }
  return value;
}
