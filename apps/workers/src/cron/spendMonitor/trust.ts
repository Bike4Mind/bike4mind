import { CreditHolderType } from '@bike4mind/common';
import { scopeMapKey, type ResolveScopeDeps, type ScopeKey } from './resolveScope';

/**
 * Who is held to the trusted-account thresholds, from the spendMonitorTrustedEmailDomains and
 * spendMonitorTrustedAccountIds admin settings.
 */
export type SpendTrustConfig = {
  emailDomains: ReadonlySet<string>;
  /** User or Organization ids. */
  accountIds: ReadonlySet<string>;
};

export const NO_TRUST: SpendTrustConfig = { emailDomains: new Set(), accountIds: new Set() };

const splitList = (raw: string): string[] =>
  raw
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(Boolean);

export function parseSpendTrustConfig(rawDomains: string, rawAccountIds: string): SpendTrustConfig {
  return {
    // A leading @ is tolerated; nothing else is normalised, so a wildcard entry simply never matches.
    emailDomains: new Set(splitList(rawDomains).map(domain => domain.toLowerCase().replace(/^@/, ''))),
    accountIds: new Set(splitList(rawAccountIds)),
  };
}

/** The part after the last @, lower-cased; null when there is no non-empty domain. */
export function emailDomainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  const domain =
    at === -1
      ? ''
      : email
          .slice(at + 1)
          .trim()
          .toLowerCase();
  return domain || null;
}

type TrustUser = { id: string; email: string | null; emailVerified?: boolean };

/**
 * Exact domain match only: a lookalike (`evil-example.com`) or a suffix trick (`example.com.attacker.test`)
 * never matches, and a subdomain matches only when listed itself. An unverified email proves nothing.
 */
export function isTrustedUser(user: TrustUser, trust: SpendTrustConfig): boolean {
  if (trust.accountIds.has(user.id)) return true;
  if (user.emailVerified !== true) return false;
  const domain = emailDomainOf(user.email);
  return domain !== null && trust.emailDomains.has(domain);
}

const isTrustConfigured = (trust: SpendTrustConfig): boolean =>
  trust.emailDomains.size > 0 || trust.accountIds.size > 0;

const uniqueIdsOf = (keys: ScopeKey[], scopeType: ScopeKey['scopeType']): string[] => [
  ...new Set(keys.filter(key => key.scopeType === scopeType).map(key => key.scopeId)),
];

/**
 * scopeMapKeys of the trusted scopes among `keys`, with one batched lookup per entity type. Users are
 * trusted by id or verified email domain, organizations by id only, and API keys and agents follow the
 * account that pays for them. Runs no query when no trust is configured.
 */
export async function resolveTrustedScopes(
  keys: ScopeKey[],
  trust: SpendTrustConfig,
  deps: ResolveScopeDeps
): Promise<Set<string>> {
  const trusted = new Set<string>();
  if (keys.length === 0 || !isTrustConfigured(trust)) return trusted;

  const apiKeyIds = uniqueIdsOf(keys, 'apiKey');
  const agentIds = uniqueIdsOf(keys, 'Agent');
  const [apiKeys, agents] = await Promise.all([
    apiKeyIds.length > 0 ? deps.findApiKeysByIds(apiKeyIds) : [],
    agentIds.length > 0 ? deps.findAgentsByIds(agentIds) : [],
  ]);

  const userIds = new Set(uniqueIdsOf(keys, 'User'));
  for (const apiKey of apiKeys) userIds.add(apiKey.userId);
  for (const agent of agents) if (agent.userId) userIds.add(agent.userId);
  // Without a domain list, a user can only be trusted by id, which needs no lookup.
  const users =
    trust.emailDomains.size > 0 && userIds.size > 0
      ? await deps.findUsersByIds([...userIds])
      : [...userIds].map(id => ({ id, email: null }));
  const trustedUserIds = new Set(users.filter(user => isTrustedUser(user, trust)).map(user => user.id));

  for (const { scopeType, scopeId } of keys) {
    if (scopeType === 'User' && trustedUserIds.has(scopeId)) trusted.add(scopeMapKey(scopeType, scopeId));
    if (scopeType === 'Organization' && trust.accountIds.has(scopeId)) trusted.add(scopeMapKey(scopeType, scopeId));
  }
  // Same payer rules as resolveScopes: an org-billed key and an ownerless agent are paid by the org.
  for (const apiKey of apiKeys) {
    const payerTrusted =
      apiKey.billingOwnerType === CreditHolderType.Organization && apiKey.organizationId
        ? trust.accountIds.has(apiKey.organizationId)
        : trustedUserIds.has(apiKey.userId);
    if (payerTrusted) trusted.add(scopeMapKey('apiKey', apiKey.id));
  }
  for (const agent of agents) {
    const payerTrusted = agent.userId
      ? trustedUserIds.has(agent.userId)
      : agent.organizationId !== undefined && trust.accountIds.has(agent.organizationId);
    if (payerTrusted) trusted.add(scopeMapKey('Agent', agent.id));
  }
  return trusted;
}
