import { normalizeEmailDomain } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';

/**
 * A domain target matches every subdomain, so a bare public suffix (co.uk, github.io) would action
 * and block unrelated accounts. Same rule as the blockedEmailDomains check in
 * pages/api/settings/update.ts. Returns the normalized domain.
 */
export function assertOwnedDomain(rawDomain: string): string {
  const domain = normalizeEmailDomain(rawDomain);
  if (!domain) throw new BadRequestError(`Not a valid domain: ${JSON.stringify(rawDomain)}`);
  if (registrableDomain(domain, { allowPrivateDomains: true }) === null) {
    throw new BadRequestError(`Not an owned domain (public suffix): ${JSON.stringify(domain)}`);
  }
  return domain;
}
