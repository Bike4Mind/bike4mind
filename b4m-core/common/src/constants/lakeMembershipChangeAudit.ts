/**
 * Lake MEMBERSHIP-change audit retention, in days.
 *
 * Twin of `constants/lakeConfigAudit.ts` and `constants/lakeAccessAudit.ts`, and here for the
 * same reason: the value is needed by both the repository that applies it (`packages/database`)
 * and any future caller in this package, which cannot reach an app-server layer.
 *
 * Fixed rather than admin-configurable (unlike the config and access audits' levers): #3052 is
 * the write path only, and a configurable retention is a lever with its own settings-schema
 * surface that the read side (#3053) is better placed to introduce once something actually reads
 * this collection back. `record()` still resolves the value through a function rather than
 * inlining the constant, so adding that lever later is a resolver change, not a schema migration.
 *
 * Matches the read-side access audit's numbers, not the config audit's 3-year figure: a
 * membership event fires on every file add/remove (access-audit volume), not only on a
 * deliberate reconfiguration (config-audit volume), so the two collections want the same
 * retention/volume trade-off.
 */
export const LAKE_MEMBERSHIP_CHANGE_AUDIT_RETENTION_DAYS = 450;

/** The one place `now + days` is computed for this collection, mirroring `lakeConfigExpiresAt`. */
export function lakeMembershipChangeExpiresAt(
  now: Date,
  days: number = LAKE_MEMBERSHIP_CHANGE_AUDIT_RETENTION_DAYS
): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
