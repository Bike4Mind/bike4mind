import { z } from 'zod';

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
