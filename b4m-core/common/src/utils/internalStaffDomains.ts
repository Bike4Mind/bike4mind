/**
 * Parse the shared, comma-separated NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS list —
 * the single source of truth for the entitlement layer and analytics (#172).
 * Empty/unset -> [] (no brand fallback). Callers pass the env value by literal
 * name so Next inlines it client-side (see requireEnv.ts bundling note).
 */
export function parseInternalStaffDomains(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map(domain => domain.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

/**
 * Parse NEXT_PUBLIC_INTERNAL_ORG_DISPLAY_NAMES (comma-separated `domain:Label` pairs) into a
 * `{ domain -> label }` map — the curated-label companion to NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS
 * (e.g. `acme.com:Acme Corp` -> `{ 'acme.com': 'Acme Corp' }`). Domain lowercased; label kept
 * verbatim after the first `:`. Empty -> {} (no brand fallback, so no brand literal ships).
 */
export function parseInternalOrgDisplayNames(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of (raw ?? '').split(',')) {
    const separator = entry.indexOf(':');
    if (separator === -1) continue;
    const domain = entry.slice(0, separator).trim().toLowerCase();
    const label = entry.slice(separator + 1).trim();
    if (domain && label) map[domain] = label;
  }
  return map;
}

/** Escape a literal string for safe interpolation into a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive regex matching any email ending in one of the given internal
 * staff domains, e.g. `/@(bike4mind\.com|milliononmars\.com)$/i`. Returns `null`
 * for an empty list (an empty alternation would match every email).
 */
export function internalStaffEmailRegex(domains: string[]): RegExp | null {
  if (domains.length === 0) return null;
  return new RegExp(`@(${domains.map(escapeRegExp).join('|')})$`, 'i');
}

/** User flags that mark an account as staff, a service identity or a test fixture rather than a customer. */
export const INTERNAL_ACCOUNT_FLAGS = ['isAdmin', 'isSystem', 'isSynthetic'] as const;

/**
 * Mongo match condition for "this joined user is staff or a test account": any of
 * INTERNAL_ACCOUNT_FLAGS is true, or the email is on a staff domain. `userPath` is where the
 * user document sits in the pipeline (e.g. `user` after a `$lookup ... as: 'user'`). A missing
 * user matches nothing, so negating this (`$nor`) keeps orphaned or non-ObjectId ids.
 *
 * The analytics report and the User Activity grid both use this, so the two never disagree on
 * who counts as internal.
 */
export function internalAccountCondition(userPath: string, staffRegex: RegExp | null): Record<string, unknown> {
  return {
    $or: [
      ...INTERNAL_ACCOUNT_FLAGS.map(flag => ({ [`${userPath}.${flag}`]: true })),
      ...(staffRegex ? [{ [`${userPath}.email`]: { $regex: staffRegex } }] : []),
    ],
  };
}
