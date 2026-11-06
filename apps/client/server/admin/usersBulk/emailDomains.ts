import { emailDomainOf, isDomainInDomains, normalizeEmailDomain } from '@bike4mind/common';
import type { AdminUsersBulkEmailDomains } from '@client/app/utils/adminUsersBulk';
import { isOwnedDomain } from '@server/admin/bulkAbuse/assertOwnedDomain';
import type { BulkUser } from './resolve';

const sorted = (domains: Set<string>) => [...domains].sort();

/**
 * The users' distinct email domains, split into owned ones (which Contain may block) and ones it never
 * blocks: public mailbox providers and public suffixes, which would block unrelated signups. A user's
 * exact domain is kept (mail.acme.com, not acme.com), so the block is never wider than the cohort; one
 * under another owned domain in the same cohort is dropped, as blocking the parent already covers it.
 */
export function emailDomainsOf(users: readonly Pick<BulkUser, 'email'>[]): { owned: string[]; notOwned: string[] } {
  const owned = new Set<string>();
  const notOwned = new Set<string>();
  for (const { email } of users) {
    const raw = email ? emailDomainOf(email) : null;
    if (!raw) continue;
    const domain = normalizeEmailDomain(raw);
    if (domain && isOwnedDomain(domain)) owned.add(domain);
    else notOwned.add(domain ?? raw);
  }
  const outermost = [...owned].filter(domain => !isDomainInDomains(domain.slice(domain.indexOf('.') + 1), owned));
  return { owned: outermost.sort(), notOwned: sorted(notOwned) };
}

/** The dry run of Contain's domain step against the current blockedEmailDomains list. */
export function planEmailDomains(
  users: readonly Pick<BulkUser, 'email'>[],
  blocked: ReadonlySet<string>
): AdminUsersBulkEmailDomains {
  const { owned, notOwned } = emailDomainsOf(users);
  return {
    toBlock: owned.filter(domain => !isDomainInDomains(domain, blocked)),
    alreadyBlocked: owned.filter(domain => isDomainInDomains(domain, blocked)),
    notOwned,
  };
}
