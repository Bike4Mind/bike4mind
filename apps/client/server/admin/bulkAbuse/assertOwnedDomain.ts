import { DISALLOWED_SIGNUP_RULE_DOMAINS, normalizeEmailDomain, personalEmailProviders } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';

const PUBLIC_MAIL_PROVIDERS = new Set<string>([...personalEmailProviders, ...DISALLOWED_SIGNUP_RULE_DOMAINS]);

/** Non-throwing assertOwnedDomain for an already-normalized domain. */
export const isOwnedDomain = (domain: string): boolean =>
  registrableDomain(domain, { allowPrivateDomains: true }) !== null && !PUBLIC_MAIL_PROVIDERS.has(domain);

/**
 * A domain target matches every subdomain, so a bare public suffix (co.uk, github.io) would action
 * and block unrelated accounts. Same rule as the blockedEmailDomains check in
 * pages/api/settings/update.ts. Also refuses public mailbox providers (gmail.com), which would ban
 * every free user and block all signups from them. Returns the normalized domain.
 */
export function assertOwnedDomain(rawDomain: string): string {
  const domain = normalizeEmailDomain(rawDomain);
  if (!domain) throw new BadRequestError(`Not a valid domain: ${JSON.stringify(rawDomain)}`);
  if (registrableDomain(domain, { allowPrivateDomains: true }) === null) {
    throw new BadRequestError(`Not an owned domain (public suffix): ${JSON.stringify(domain)}`);
  }
  if (PUBLIC_MAIL_PROVIDERS.has(domain)) {
    throw new BadRequestError(`Public mailbox provider, not an owned domain: ${JSON.stringify(domain)}`);
  }
  return domain;
}
