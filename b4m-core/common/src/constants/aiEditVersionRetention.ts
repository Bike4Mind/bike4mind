/**
 * How many AI-edited versions of a file are retained (in `versions[]` and in storage), in addition
 * to the original upload (v1), which is always kept. Lives here because both the admin-settings
 * schema and the edit routes / trim script that apply it need it.
 */
export const AI_EDIT_VERSION_RETENTION_DEFAULT = 10;
export const AI_EDIT_VERSION_RETENTION_MIN = 1;
export const AI_EDIT_VERSION_RETENTION_MAX = 100;

/** An unset/blank/non-finite input yields the default; any numeric input is floored and clamped. */
export function resolveAiEditVersionRetention(value?: number | string | null): number {
  const parsed = value === null || value === undefined || value === '' ? NaN : Number(value);
  if (!Number.isFinite(parsed)) return AI_EDIT_VERSION_RETENTION_DEFAULT;
  return Math.min(Math.max(Math.floor(parsed), AI_EDIT_VERSION_RETENTION_MIN), AI_EDIT_VERSION_RETENTION_MAX);
}
