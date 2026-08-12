/**
 * Lake access audit retention limits, in DAYS.
 *
 * Live here (not next to the model) for the same reason as `constants/chunking.ts`: the values
 * are needed by both the admin-settings schema in this package and by the repository that
 * applies them (`packages/database`, which cannot import an app-server layer), so they must sit
 * somewhere both can reach without a cycle.
 *
 * The audit-retention FLOOR is the point of this file. #1658's levers rule ("adjustable does not
 * mean unbounded") exists because an org could otherwise configure its own retention to nothing
 * and defeat the audit control the workstream exists to provide - so `resolveLakeAccessAuditRetentionDays`
 * is a one-way ratchet UP: no input path can produce fewer than `LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS`.
 *
 * This is a PLATFORM-level lever, not a per-org one - no scoped settings resolver
 * (platform -> org -> owner -> lake) exists yet. When one lands, the invariant to preserve is
 * `max(orgConfigured, PLATFORM_FLOOR)` - the floor belongs to the platform, never to the org.
 */

/** ~15 months: 12 months live retention plus a ~3-month Type II observation-window tail. */
export const LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS = 450;
/** A separate constant from the floor on purpose, even though they agree today - a future change
 * to one must not silently move the other. */
export const LAKE_ACCESS_AUDIT_RETENTION_DEFAULT_DAYS = 450;
/** Ceiling so "adjustable" cannot mean "unbounded" in either direction. */
export const LAKE_ACCESS_AUDIT_RETENTION_MAX_DAYS = 2555;

export const LAKE_ACCESS_QUERY_TEXT_RETENTION_DEFAULT_DAYS = 30;
export const LAKE_ACCESS_QUERY_TEXT_RETENTION_MIN_DAYS = 1;
export const LAKE_ACCESS_QUERY_TEXT_RETENTION_MAX_DAYS = 90;

/** Query text is the most useful field for a customer and the most sensitive; capped rather than
 * stored verbatim so an unusually long query cannot balloon the (already short-retention) row. */
export const LAKE_ACCESS_QUERY_TEXT_MAX_CHARS = 4000;

/** An unset/blank/non-finite input yields the default; any numeric input is clamped into
 * [FLOOR, MAX] - the floor applies unconditionally, even to an explicit low value. */
export function resolveLakeAccessAuditRetentionDays(configuredDays?: number | null): number {
  const parsed = typeof configuredDays === 'number' ? configuredDays : Number(configuredDays);
  if (!Number.isFinite(parsed)) return LAKE_ACCESS_AUDIT_RETENTION_DEFAULT_DAYS;
  return Math.min(
    Math.max(Math.floor(parsed), LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS),
    LAKE_ACCESS_AUDIT_RETENTION_MAX_DAYS
  );
}

/**
 * Query-text retention must be strictly shorter than the audit event's own retention - a value
 * this cannot express with a static max, since it depends on another, dynamically-resolved
 * setting. Clamped into [MIN, min(MAX, effectiveAuditDays - 1)] so equality at the boundary
 * (both configured to the same value) still yields a strictly shorter result.
 */
export function resolveLakeAccessQueryTextRetentionDays(
  configuredDays: number | null | undefined,
  effectiveAuditDays: number
): number {
  const parsed = typeof configuredDays === 'number' ? configuredDays : Number(configuredDays);
  const upperBound = Math.max(
    LAKE_ACCESS_QUERY_TEXT_RETENTION_MIN_DAYS,
    Math.min(LAKE_ACCESS_QUERY_TEXT_RETENTION_MAX_DAYS, effectiveAuditDays - 1)
  );
  const base = Number.isFinite(parsed) ? Math.floor(parsed) : LAKE_ACCESS_QUERY_TEXT_RETENTION_DEFAULT_DAYS;
  return Math.min(Math.max(base, LAKE_ACCESS_QUERY_TEXT_RETENTION_MIN_DAYS), upperBound);
}

/** The one place `now + days` is computed, so the event and query-text collections cannot drift
 * on the arithmetic (three existing audit models each re-inline this independently). */
export function lakeAccessExpiresAt(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
