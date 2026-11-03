import { z } from 'zod';
import type { ShadowDetectionSignal } from './shadowDetection';

/**
 * Coordinated account campaigns: candidate groups of recent accounts linked by independent evidence
 * (network, mail domain, client fingerprint, lifecycle timing). Shadow-only: a group is recorded as an
 * `accountCampaign` shadow detection for admin grading (see ./shadowDetection.ts) and never feeds
 * signupRiskScore, riskScore.reviewState or any other access decision.
 *
 * The engine is b4m-core/services/src/userService/accountCampaigns.ts; this file is the contract its
 * output and the stored group evidence share, so other consumers (model judgments, review tooling) can
 * read a group without knowing how it was built. Bump ACCOUNT_CAMPAIGN_POLICY_VERSION whenever a rule
 * or threshold below changes, so precision is measured per policy.
 */
export const ACCOUNT_CAMPAIGN_POLICY_VERSION = 1;

/**
 * How two accounts can be related. Each kind belongs to one evidence family (ACCOUNT_CAMPAIGN_FAMILY_OF).
 * - networkPrefix: same signup IPv4 /24 or IPv6 /48
 * - hostingAsn: same hosting (datacenter) ASN at signup; consumer ASNs are too broad to relate accounts
 * - mailDomain: same registrable mail domain, never a personal mailbox provider
 * - fingerprint: same JA4 client fingerprint, only when it is uncommon
 * - lifecycle: signed up close together and ran the same server-confirmed steps (email verified,
 *   first API key, first usage) at matching offsets from signup
 */
export const ACCOUNT_CAMPAIGN_RELATIONSHIPS = [
  'networkPrefix',
  'hostingAsn',
  'mailDomain',
  'fingerprint',
  'lifecycle',
] as const;
export type AccountCampaignRelationship = (typeof ACCOUNT_CAMPAIGN_RELATIONSHIPS)[number];

/**
 * Evidence axes counted for independence. A shared network and a shared mail domain both say "same
 * organization" (a school, a company), so together they are one axis, not two.
 */
export const ACCOUNT_CAMPAIGN_AXES = ['affiliation', 'client', 'behavior'] as const;
export type AccountCampaignAxis = (typeof ACCOUNT_CAMPAIGN_AXES)[number];

export const ACCOUNT_CAMPAIGN_AXIS_OF = {
  networkPrefix: 'affiliation',
  hostingAsn: 'affiliation',
  mailDomain: 'affiliation',
  fingerprint: 'client',
  lifecycle: 'behavior',
} as const satisfies Record<AccountCampaignRelationship, AccountCampaignAxis>;

/** A direct link needs evidence on at least this many distinct axes. */
export const ACCOUNT_CAMPAIGN_MIN_AXES = 2;

const ObjectIdStringSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid id');

/**
 * direct: in the group's dense core (every link it has there is closed by a third member).
 * transitive: linked to one or more core members but not part of the core; shown for context, and
 * never a reason on its own to act on the account.
 */
export const ACCOUNT_CAMPAIGN_MEMBERSHIPS = ['direct', 'transitive'] as const;
export type AccountCampaignMembership = (typeof ACCOUNT_CAMPAIGN_MEMBERSHIPS)[number];

export const accountCampaignMemberSchema = z.object({
  userId: ObjectIdStringSchema,
  membership: z.enum(ACCOUNT_CAMPAIGN_MEMBERSHIPS),
  /** Direct links to other members of this group. */
  linkCount: z.number().int().min(0),
  signedUpAt: z.date(),
});
export type AccountCampaignMember = z.infer<typeof accountCampaignMemberSchema>;

/** One direct link: the two accounts and every relationship that held between them. */
export const accountCampaignLinkSchema = z.object({
  userIds: z.tuple([ObjectIdStringSchema, ObjectIdStringSchema]),
  relationships: z.array(z.enum(ACCOUNT_CAMPAIGN_RELATIONSHIPS)).min(1),
});
export type AccountCampaignLink = z.infer<typeof accountCampaignLinkSchema>;

/**
 * A value members share that counted as evidence. `population` is how many scanned accounts had the
 * value, so a reviewer sees how rare it is. Lifecycle evidence has no shared value: it is the timing
 * pattern, described in `label`.
 */
export const accountCampaignEvidenceSchema = z.object({
  relationship: z.enum(ACCOUNT_CAMPAIGN_RELATIONSHIPS),
  axis: z.enum(ACCOUNT_CAMPAIGN_AXES),
  value: z.string().nullable(),
  label: z.string(),
  population: z.number().int().min(0),
  userIds: z.array(ObjectIdStringSchema),
});
export type AccountCampaignEvidence = z.infer<typeof accountCampaignEvidenceSchema>;

export const ACCOUNT_CAMPAIGN_IGNORED_REASONS = ['common', 'personalMailProvider'] as const;
export type AccountCampaignIgnoredReason = (typeof ACCOUNT_CAMPAIGN_IGNORED_REASONS)[number];

/** A value members share that was NOT counted, and why, so a reviewer sees what was discounted. */
export const accountCampaignIgnoredSchema = z.object({
  relationship: z.enum(ACCOUNT_CAMPAIGN_RELATIONSHIPS),
  value: z.string(),
  population: z.number().int().min(0),
  reason: z.enum(ACCOUNT_CAMPAIGN_IGNORED_REASONS),
  memberCount: z.number().int().min(0),
});
export type AccountCampaignIgnored = z.infer<typeof accountCampaignIgnoredSchema>;

export const accountCampaignGroupSchema = z.object({
  policyVersion: z.number().int(),
  /** The signup window the scan covered. */
  window: z.object({ from: z.date(), to: z.date() }),
  /** When the group was first and most recently computed; a group not seen again is stale. */
  firstObservedAt: z.date(),
  lastObservedAt: z.date(),
  members: z.array(accountCampaignMemberSchema),
  links: z.array(accountCampaignLinkSchema),
  evidence: z.array(accountCampaignEvidenceSchema),
  ignored: z.array(accountCampaignIgnoredSchema),
  /**
   * Members whose value was not captured. Unknown is neither evidence for nor against a link: a member
   * with no fingerprint simply cannot share one.
   */
  unknown: z.object({ fingerprint: z.number().int().min(0), network: z.number().int().min(0) }),
  /** True when a member or link list was cut to its stored cap; totals are the uncut counts. */
  truncated: z.boolean(),
  totals: z.object({ direct: z.number().int(), transitive: z.number().int(), links: z.number().int() }),
});
export type AccountCampaignGroup = z.infer<typeof accountCampaignGroupSchema>;

/** The smallest group the engine emits: one triangle of direct members. */
export const ACCOUNT_CAMPAIGN_MIN_DIRECT_MEMBERS = 3;

export const ACCOUNT_CAMPAIGN_RELATIONSHIP_LABELS: Record<AccountCampaignRelationship, string> = {
  networkPrefix: 'network prefix',
  hostingAsn: 'hosting network',
  mailDomain: 'mail domain',
  fingerprint: 'client fingerprint',
  lifecycle: 'lifecycle timing',
};

/** The shadow detection summary line for a group, e.g. "5 accounts linked by client fingerprint (+1 transitive)". */
export function accountCampaignSummary(group: AccountCampaignGroup): string {
  const relationships = [...new Set(group.evidence.map(entry => entry.relationship))];
  const transitive = group.totals.transitive > 0 ? ` (+${group.totals.transitive} transitive)` : '';
  return `${group.totals.direct} accounts linked by ${relationships
    .map(relationship => ACCOUNT_CAMPAIGN_RELATIONSHIP_LABELS[relationship])
    .join(', ')}${transitive}`;
}

export function accountCampaignSignals(group: AccountCampaignGroup): ShadowDetectionSignal[] {
  return [
    {
      key: 'directMembers',
      label: 'Directly linked accounts',
      observed: group.totals.direct,
      threshold: ACCOUNT_CAMPAIGN_MIN_DIRECT_MEMBERS,
    },
    {
      key: 'transitiveMembers',
      label: 'Transitively linked accounts',
      observed: group.totals.transitive,
      threshold: null,
    },
    { key: 'links', label: 'Direct links', observed: group.totals.links, threshold: null },
    {
      key: 'axes',
      label: 'Independent evidence axes',
      observed: new Set(group.evidence.map(entry => entry.axis)).size,
      threshold: ACCOUNT_CAMPAIGN_MIN_AXES,
    },
  ];
}

/**
 * The group as it stands once an account is deleted, or null when no triangle of direct members is
 * left. A transitive member whose every stored link ran through the deleted account goes with it, and a
 * shared value held by fewer than two remaining members stops being evidence. Counts the stored lists
 * cannot recompute (ignored memberCount, unknown) are capped at the remaining member count.
 */
export function withoutCampaignMember(group: AccountCampaignGroup, userId: string): AccountCampaignGroup | null {
  const touchesRemoved = (link: AccountCampaignLink) => link.userIds.includes(userId);
  const links = group.links.filter(link => !touchesRemoved(link));
  const orphaned = new Set(
    group.members
      .filter(
        member =>
          member.membership === 'transitive' &&
          group.links.some(link => link.userIds.includes(member.userId) && touchesRemoved(link)) &&
          !links.some(link => link.userIds.includes(member.userId))
      )
      .map(member => member.userId)
  );
  const dropped = new Set([userId, ...orphaned]);
  const removedLinks = group.links.filter(touchesRemoved);
  const members = group.members
    .filter(member => !dropped.has(member.userId))
    .map(member => ({
      ...member,
      linkCount: member.linkCount - removedLinks.filter(link => link.userIds.includes(member.userId)).length,
    }));
  const direct = members.filter(member => member.membership === 'direct').length;
  if (direct < ACCOUNT_CAMPAIGN_MIN_DIRECT_MEMBERS) return null;

  const droppedDirect = group.members.filter(
    member => dropped.has(member.userId) && member.membership === 'direct'
  ).length;
  const droppedTransitive = group.members.filter(
    member => dropped.has(member.userId) && member.membership === 'transitive'
  ).length;
  const remaining = members.length;
  return {
    ...group,
    members,
    links,
    evidence: group.evidence
      .map(entry => ({ ...entry, userIds: entry.userIds.filter(id => !dropped.has(id)) }))
      .filter(entry => entry.userIds.length >= 2),
    ignored: group.ignored
      .map(entry => ({ ...entry, memberCount: Math.min(entry.memberCount, remaining) }))
      .filter(entry => entry.memberCount >= 2),
    unknown: {
      fingerprint: Math.min(group.unknown.fingerprint, remaining),
      network: Math.min(group.unknown.network, remaining),
    },
    totals: {
      direct: group.totals.direct - droppedDirect,
      transitive: group.totals.transitive - droppedTransitive,
      links: group.totals.links - removedLinks.length,
    },
  };
}
