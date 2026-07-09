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
