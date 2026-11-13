import { getDomain, getPublicSuffix } from 'tldts';

export interface RegistrableDomainOptions {
  /**
   * Treat PSL *private* suffixes (e.g. `github.io`, `web.app`) as public, so a
   * bare `github.io` returns `null` and `foo.github.io` returns `foo.github.io`.
   * Use this when VALIDATING an allowlist entry so a shared platform suffix can't
   * be entered as if it were an owned domain.
   */
  allowPrivateDomains?: boolean;
}

/**
 * The registrable domain (eTLD+1) of a host or bare email domain, lowercased,
 * or `null` when there isn't one - invalid input, or a bare public suffix like
 * `co.uk` (which has no owner). Pass the domain portion of an email, not the
 * full address.
 *
 * `mail.acme.com` and `acme.com` both -> `acme.com`; `acme.co.uk` and
 * `sub.acme.co.uk` both -> `acme.co.uk`.
 *
 * NOTE on suffix nuance: default PSL does NOT list every shared SaaS suffix
 * (e.g. `onmicrosoft.com` is a normal registrable domain), so this is safe for
 * grouping/validation but NOT sufficient on its own to decide access - a domain
 * allowlist must match entries AS STORED (exact or subdomain), never by reducing
 * an entry to this value, or `a.onmicrosoft.com` would collapse into every other
 * tenant. See checkAccessGate.
 *
 * Import from the lightweight subpath (`@bike4mind/utils/registrableDomain`),
 * NOT the package barrel - the barrel eagerly evaluates heavy code (see the
 * escapeRegex note).
 */
export function registrableDomain(input: string | null | undefined, opts?: RegistrableDomainOptions): string | null {
  if (!input) return null;
  return getDomain(input.trim().toLowerCase(), opts);
}

/**
 * True when `entry` is itself a public suffix, ICANN or private-section (`com`, `co.uk`,
 * `github.io`): a list entry that would cover every site anyone can create under it.
 */
export function isPublicSuffixEntry(entry: string): boolean {
  const normalized = entry.trim().toLowerCase();
  return normalized.length > 0 && getPublicSuffix(normalized, { allowPrivateDomains: true }) === normalized;
}

/**
 * True only when `entry` equals, or sits below, the registrable domain of `host`. An entry above
 * that (`amazonaws.com` for `x.s3.amazonaws.com`) never covers the host, even though a suffix match
 * would, because the host belongs to whoever registered the label under the shared suffix.
 */
export function trustedEntryCoversHost(entry: string, host: string): boolean {
  const domain = registrableDomain(host, { allowPrivateDomains: true });
  const normalized = entry.trim().toLowerCase();
  if (!domain || !normalized) return false;
  return normalized === domain || normalized.endsWith(`.${domain}`);
}
