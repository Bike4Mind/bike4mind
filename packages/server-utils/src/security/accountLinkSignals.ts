import { canonicalizeEmail, emailDomainOf } from '@bike4mind/common';
import { userService } from '@bike4mind/services';

/**
 * Traits that tie two accounts to one operator, and the email shape signals behind them. Shared by
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
  'tutanota.com',
]);

export const isConsumerMailDomain = (domain: string): boolean =>
  CONSUMER_MAIL_DOMAINS.has(domain) || /^(hotmail|outlook|live|yahoo)\.[a-z.]+$/.test(domain);

export type EmailPatternSignals = {
  plusAddressed: boolean;
  /** The `+tag` mixes letters and digits over 6+ characters, as a script's counter or nonce does. */
  randomLookingPlusTag: boolean;
  /** The local part (tag aside) is a name with a hex counter, as signupRiskScore reads it. */
  generatedLocalPart: boolean;
  consumerMailDomain: boolean;
};

const RANDOM_TAG = /^(?=.*\d)(?=.*[a-z])[a-z0-9]{6,}$/i;

export function emailPatternSignals(email: string | null): EmailPatternSignals | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  const domain = emailDomainOf(normalized);
  if (at <= 0 || !domain) return null;
  const local = normalized.slice(0, at);
  const plus = local.indexOf('+');
  const tag = plus > 0 ? local.slice(plus + 1) : '';
  const base = plus > 0 ? local.slice(0, plus) : local;
  return {
    plusAddressed: plus > 0,
    randomLookingPlusTag: RANDOM_TAG.test(tag),
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
  /** Only for a non-consumer domain; null otherwise. */
  mailDomain: string | null;
};

export function accountLinkKeys(account: Omit<LinkableAccount, 'id'>): AccountLinkKeys {
  const domain = account.email ? emailDomainOf(account.email.trim().toLowerCase()) : null;
  return {
    signupIp: account.signupIp || null,
    ja4: account.signupJa4 || null,
    mailbox: account.email ? canonicalizeEmail(account.email) : null,
    mailDomain: domain && !isConsumerMailDomain(domain) ? domain : null,
  };
}

/** The traits two accounts share; empty when unrelated. */
export function sharedLinkKinds(a: Omit<LinkableAccount, 'id'>, b: Omit<LinkableAccount, 'id'>): AccountLinkKind[] {
  const keysA = accountLinkKeys(a);
  const keysB = accountLinkKeys(b);
  return ACCOUNT_LINK_KINDS.filter(kind => {
    const value = keysA[kind];
    return value !== null && value === keysB[kind];
  });
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
