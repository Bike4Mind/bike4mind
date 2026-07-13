import { getDomain } from 'tldts';

/**
 * The registrable domain (eTLD+1) of a host or bare email domain, lowercased,
 * or `null` when there isn't one - invalid input, or a bare public suffix like
 * `co.uk` (which has no owner and must never be used as an allowlist entry).
 *
 * `mail.acme.com` and `acme.com` both -> `acme.com`; `acme.co.uk` and
 * `sub.acme.co.uk` both -> `acme.co.uk`. Pass the domain portion of an email,
 * not the full address.
 *
 * Import from the lightweight subpath (`@bike4mind/utils/registrableDomain`),
 * NOT the package barrel - the barrel eagerly evaluates heavy code (see the
 * escapeRegex note).
 */
export function registrableDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  return getDomain(input.trim().toLowerCase());
}
