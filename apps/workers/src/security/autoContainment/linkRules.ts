import type { LinkRule, LinkRuleFacts } from '@bike4mind/common';

/**
 * Deterministic link rules: account facts that decide a reversible graduated tier (Limit or Hold
 * signup grant) when the abuse model does not act. Pure; the facts are loaded by
 * packages/server-utils/src/security/autoContainment/linkRuleFacts.ts and the tier gates applied in
 * policy.ts. Thresholds and order are part of the versioned table (INTERVENTION_POLICY_VERSION).
 */

export type LinkRuleTier = 'limit' | 'holdGrant';

export type LinkRuleHit = { rule: LinkRule; tier: LinkRuleTier; why: string };

export type LinkRuleDecision = { tier: LinkRuleTier; userIds: string[]; rules: LinkRule[]; reason: string };

export const MIN_DOMAIN_CLUSTER_ACCOUNTS = 3;
export const MIN_DOMAIN_CLUSTER_SPENDERS = 2;

/** The rule reported when several fire for one account; a limit rule always outranks a holdGrant one. */
export const LINK_RULE_PRECEDENCE: readonly LinkRule[] = ['bannedSameDevice', 'sharedOwnedDomain', 'heldSignupDomain'];

const TIER_RANK: Record<LinkRuleTier, number> = { limit: 0, holdGrant: 1 };

function firingRules(facts: LinkRuleFacts): LinkRuleHit[] {
  const hits: LinkRuleHit[] = [];
  const devices = facts.bannedSameDevice ?? 0;
  if (devices >= 1 && facts.creditsSpent > 0) {
    hits.push({
      rule: 'bannedSameDevice',
      tier: 'limit',
      why: `same device as ${devices} banned account(s), spent credits`,
    });
  }
  const cluster = facts.ownedDomainCluster;
  if (cluster && cluster.accounts >= MIN_DOMAIN_CLUSTER_ACCOUNTS && cluster.spenders >= MIN_DOMAIN_CLUSTER_SPENDERS) {
    hits.push({
      rule: 'sharedOwnedDomain',
      tier: facts.creditsSpent > 0 ? 'limit' : 'holdGrant',
      why: `${cluster.accounts} accounts on ${cluster.domain}, ${cluster.spenders} spent credits`,
    });
  }
  if (facts.adminHeldDomain !== null) {
    hits.push({
      rule: 'heldSignupDomain',
      tier: 'holdGrant',
      why: `signup domain ${facts.adminHeldDomain} blocked by an admin`,
    });
  }
  return hits;
}

/** The rule that decides one account's tier, or null when none fires or the account is never touched. */
export function evaluateLinkRules(facts: LinkRuleFacts): LinkRuleHit | null {
  if (facts.paying || facts.partnerDomain) return null;
  const hits = firingRules(facts);
  if (hits.length === 0) return null;
  return [...hits].sort(
    (a, b) =>
      TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
      LINK_RULE_PRECEDENCE.indexOf(a.rule) - LINK_RULE_PRECEDENCE.indexOf(b.rule)
  )[0];
}

/** One tier for a detection: Limit when any fired account needs it, else Hold signup grant. Null when no rule fires. */
export function decideLinkRules(facts: readonly LinkRuleFacts[]): LinkRuleDecision | null {
  const fired = facts.flatMap(account => {
    const hit = evaluateLinkRules(account);
    return hit ? [{ userId: account.userId, hit }] : [];
  });
  if (fired.length === 0) return null;
  const tier: LinkRuleTier = fired.some(({ hit }) => hit.tier === 'limit') ? 'limit' : 'holdGrant';
  const rules = LINK_RULE_PRECEDENCE.filter(rule => fired.some(({ hit }) => hit.rule === rule));
  return {
    tier,
    userIds: [...new Set(fired.map(({ userId }) => userId))],
    rules,
    reason: [...new Set(fired.map(({ hit }) => hit.why))].join('; '),
  };
}
