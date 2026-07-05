/**
 * Domain matching utilities for the network proxy allowlist.
 * Pure functions, zero dependencies.
 */

/**
 * Normalize a domain for comparison: lowercase, strip port, strip trailing dot.
 */
export function normalizeDomain(domain: string): string {
  let d = domain.toLowerCase().trim();
  // Strip port (e.g., github.com:443 -> github.com)
  const colonIdx = d.lastIndexOf(':');
  if (colonIdx > 0) {
    const afterColon = d.slice(colonIdx + 1);
    if (/^\d+$/.test(afterColon)) {
      d = d.slice(0, colonIdx);
    }
  }
  // Strip trailing dot (DNS root); after port strip so "host.:443" works
  if (d.endsWith('.')) {
    d = d.slice(0, -1);
  }
  return d;
}

/**
 * Check if a domain matches a pattern.
 * - Exact match: "github.com" matches "github.com"
 * - Wildcard: "*.github.com" matches "api.github.com" but NOT "github.com"
 */
export function matchesDomain(domain: string, pattern: string): boolean {
  const d = normalizeDomain(domain);
  const p = normalizeDomain(pattern);

  if (d === p) return true;

  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".github.com"
    return d.endsWith(suffix) && d.length > suffix.length;
  }

  return false;
}

/**
 * Check if a domain is in the allowed list.
 */
export function isDomainAllowed(domain: string, allowedDomains: string[]): boolean {
  if (!domain || allowedDomains.length === 0) return false;
  return allowedDomains.some(pattern => matchesDomain(domain, pattern));
}
