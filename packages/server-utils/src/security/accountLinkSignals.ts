import {
  canonicalizeEmail,
  emailDomainOf,
  plusAddressTagOf,
  isRandomLookingTag,
  personalEmailProviders,
  regionalPersonalEmailProviders,
} from '@bike4mind/common';
import { userService } from '@bike4mind/services';
import { truncateIp } from '../utils/ip';

/**
 * Shared account traits and email-shape signals for review; none establishes common ownership alone. Shared by
 * the signup network burst detector (apps/client/server/auth/signupNetworkAlerts.ts), the
 * young-account spend detector (apps/workers/src/cron/youngAccountSpendShadowDetections.ts) and the
 * advisory abuse assessment's account profile (apps/client/server/security/abuseAssessment).
 * Pure: callers load the accounts.
 */

/**
 * Consumer mail providers: millions of unrelated people share these domains, so a shared domain
 * here links nothing (a shared mailbox still does).
 */
export const CONSUMER_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  ...personalEmailProviders,
  ...regionalPersonalEmailProviders,
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'protonmail.ch',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  'mail.com',
  'mail.ru',
  'yandex.com',
  'yandex.ru',
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
  'zoho.com',
  'fastmail.com',
  'fastmail.fm',
  'tutanota.com',
  'comcast.net',
  'att.net',
  'sbcglobal.net',
  'verizon.net',
  'bellsouth.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'btinternet.com',
  'sky.com',
  'virginmedia.com',
  't-online.de',
  'freenet.de',
  'orange.fr',
  'free.fr',
  'sfr.fr',
  'laposte.net',
  'wanadoo.fr',
  'libero.it',
  'virgilio.it',
  'alice.it',
  'foxmail.com',
  'rambler.ru',
  'seznam.cz',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  'rediffmail.com',
  'hey.com',
]);

export const isConsumerMailDomain = (domain: string): boolean =>
  CONSUMER_MAIL_DOMAINS.has(domain) || /^(hotmail|outlook|live|yahoo)\.[a-z.]+$/.test(domain);

export type EmailPatternSignals = {
  plusAddressed: boolean;
  /** Uses the shared provider-aware plus-tag heuristic; a soft context signal only. */
  randomLookingPlusTag: boolean;
  /** The local part (tag aside) is a name with a hex counter, as signupRiskScore reads it. */
  generatedLocalPart: boolean;
  consumerMailDomain: boolean;
};

export function emailPatternSignals(email: string | null): EmailPatternSignals | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  const domain = emailDomainOf(normalized);
  if (at <= 0 || !domain) return null;
  const local = normalized.slice(0, at);
  const plus = local.indexOf('+');
  const tag = plusAddressTagOf(normalized);
  const base = plus > 0 ? local.slice(0, plus) : local;
  return {
    plusAddressed: tag !== null,
    randomLookingPlusTag: tag !== null && isRandomLookingTag(tag),
    generatedLocalPart: userService.looksGeneratedLocalPart(`${base}@${domain}`),
    consumerMailDomain: isConsumerMailDomain(domain),
  };
}

export const ACCOUNT_LINK_KINDS = ['signupIp', 'ja4', 'mailbox', 'mailDomain'] as const;
export type AccountLinkKind = (typeof ACCOUNT_LINK_KINDS)[number];

export type LinkableAccount = {
  id: string;
  email: string | null;
  signupIp: string | null;
  signupJa4: string | null;
};

export type AccountLinkKeys = {
  signupIp: string | null;
  ja4: string | null;
  /** The delivering inbox (plus tags and Gmail dots folded), see canonicalizeEmail. */
  mailbox: string | null;
  /** Only for a domain one organization owns: null for consumer mail and privacy relays. */
  mailDomain: string | null;
};

export function accountLinkKeys(account: Omit<LinkableAccount, 'id'>): AccountLinkKeys {
  const domain = account.email ? emailDomainOf(account.email.trim().toLowerCase()) : null;
  return {
    // Retention truncates old signup IPs to a prefix, which many unrelated accounts share.
    signupIp: account.signupIp && truncateIp(account.signupIp) !== account.signupIp ? account.signupIp : null,
    ja4: account.signupJa4 || null,
    mailbox: account.email ? canonicalizeEmail(account.email) : null,
    mailDomain: domain && !isConsumerMailDomain(domain) && !userService.isPrivacyRelayDomain(domain) ? domain : null,
  };
}

/**
 * The traits two accounts share; empty when unrelated. A JA4 is shared by everyone on the same
 * browser build, so it is reported only beside another shared trait and never links on its own.
 */
export function sharedLinkKinds(a: Omit<LinkableAccount, 'id'>, b: Omit<LinkableAccount, 'id'>): AccountLinkKind[] {
  const keysA = accountLinkKeys(a);
  const keysB = accountLinkKeys(b);
  const shared = ACCOUNT_LINK_KINDS.filter(kind => {
    const value = keysA[kind];
    return value !== null && value === keysB[kind];
  });
  return shared.some(kind => kind !== 'ja4') ? shared : [];
}

export type LinkedAccountGroup = { memberIds: string[]; kinds: AccountLinkKind[] };

/**
 * Partitions accounts into groups joined by any shared trait (transitively). Every account lands in
 * exactly one group; an unlinked account is a group of one with no kinds. Groups keep input order.
 */
export function groupLinkedAccounts(accounts: readonly LinkableAccount[]): LinkedAccountGroup[] {
  const parent = accounts.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const kindsByRoot = new Map<number, Set<AccountLinkKind>>();
  const edges: { a: number; b: number; kinds: AccountLinkKind[] }[] = [];
  for (let i = 0; i < accounts.length; i += 1) {
    for (let j = i + 1; j < accounts.length; j += 1) {
      const kinds = sharedLinkKinds(accounts[i], accounts[j]);
      if (kinds.length === 0) continue;
      edges.push({ a: i, b: j, kinds });
      const rootA = find(i);
      const rootB = find(j);
      if (rootA !== rootB) parent[rootB] = rootA;
    }
  }
  for (const edge of edges) {
    const root = find(edge.a);
    const kinds = kindsByRoot.get(root) ?? new Set<AccountLinkKind>();
    edge.kinds.forEach(kind => kinds.add(kind));
    kindsByRoot.set(root, kinds);
  }
  const groups = new Map<number, LinkedAccountGroup>();
  accounts.forEach((account, index) => {
    const root = find(index);
    const group = groups.get(root) ?? {
      memberIds: [],
      kinds: ACCOUNT_LINK_KINDS.filter(kind => kindsByRoot.get(root)?.has(kind)),
    };
    group.memberIds.push(account.id);
    groups.set(root, group);
  });
  return [...groups.values()];
}
