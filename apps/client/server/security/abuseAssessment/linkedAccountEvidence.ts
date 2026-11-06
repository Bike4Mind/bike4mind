import { ABUSE_ASSESSMENT_MAX_ACCOUNTS, type AbuseAssessmentGroupEvidence } from '@bike4mind/common';
import { usageEventRepository, userRepository } from '@bike4mind/database';
import type { UserSignupLinkFacts } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { findLinkedAccounts, type LinkedAccount } from '@server/billing/linkedAccounts';
import type { AbuseAssessmentGroupEvidenceSource } from './abuseAssessment';

/**
 * Group evidence for an abuse assessment from what the detection's accounts signed up and paid with:
 * the accounts sharing their signup IP or card (and whether any is already blocked), an OAuth signup
 * that landed on another account's notebook, the turn that settled furthest above its credit hold,
 * and how and from what network they signed up. Counts and flags only; members are referenced by
 * the assessment's own refs, so no id, IP or email reaches the provider.
 */

export const LINKED_ACCOUNT_EVIDENCE_SOURCE = 'linkedAccounts';
/** Bump when a signal is added, removed or changes meaning. */
export const LINKED_ACCOUNT_EVIDENCE_VERSION = 1;

const HOUR_MS = 60 * 60 * 1000;
// How far back a settlement above its hold counts; young-account abuse lands within days.
const SETTLEMENT_LOOKBACK_MS = 30 * 24 * HOUR_MS;
const EMAIL_SIGNUP_METHODS: ReadonlySet<string> = new Set(['otc', 'email', 'password']);

export type LinkedAccountEvidenceDeps = {
  findSignupLinkFacts: (ids: string[]) => Promise<UserSignupLinkFacts[]>;
  findLinkedAccounts: (user: { id: string; signupMeta: { ip: string } }) => Promise<LinkedAccount[]>;
  /** Whether each id is blocked (banned, dispute-locked or moderated); unknown ids are absent. */
  blockedStates: (ids: string[]) => Promise<Map<string, boolean>>;
  largestSettlementOverHold: typeof usageEventRepository.largestSettlementOverHold;
  now: () => Date;
};

const liveDeps: LinkedAccountEvidenceDeps = {
  findSignupLinkFacts: ids => userRepository.findSignupLinkFacts(ids),
  findLinkedAccounts: user => findLinkedAccounts(user),
  blockedStates: async ids => {
    const states = await userRepository.findLinkStatesByIds(ids);
    return new Map(states.map(state => [state.id, userService.accountBlockReasons(state).length > 0]));
  },
  largestSettlementOverHold: (ids, since) => usageEventRepository.largestSettlementOverHold(ids, since),
  now: () => new Date(),
};

type Signal = AbuseAssessmentGroupEvidence['signals'][number];

const hoursBetween = (a: Date | null, b: Date | null): number | null =>
  a && b ? Math.round(Math.abs(a.getTime() - b.getTime()) / HOUR_MS) : null;

const minOf = (values: (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? Math.min(...known) : null;
};

/** Builds the evidence for a set of accounts; exported for tests and the strong-link rule. */
export async function buildLinkedAccountEvidence(
  userIds: readonly string[],
  refFor: (userId: string) => string | null,
  deps: LinkedAccountEvidenceDeps = liveDeps
): Promise<AbuseAssessmentGroupEvidence | null> {
  const ids = userIds.slice(0, ABUSE_ASSESSMENT_MAX_ACCOUNTS);
  if (ids.length === 0) return null;
  const members = new Set(ids);
  const facts = await deps.findSignupLinkFacts(ids);

  const linksPerMember = await Promise.all(
    facts.map(async fact => ({
      fact,
      // Links among the detection's own accounts are the detection, not extra evidence.
      links: fact.signupIp
        ? (await deps.findLinkedAccounts({ id: fact.id, signupMeta: { ip: fact.signupIp } })).filter(
            link => !members.has(link.id)
          )
        : [],
    }))
  );
  const viaSignupIp = (links: LinkedAccount[]) => links.filter(link => link.via.includes('signupNetwork'));
  const signupIpLinks = linksPerMember.map(({ links }) => viaSignupIp(links));
  const blockedSignupIpLinks = linksPerMember.map(({ fact, links }) =>
    viaSignupIp(links)
      .filter(link => link.blocked)
      .map(link => hoursBetween(fact.createdAt, link.createdAt))
  );

  const landingOwners = [
    ...new Set(facts.flatMap(fact => (fact.landingNotebookOwnerId ? [fact.landingNotebookOwnerId] : []))),
  ];
  const ownerBlocked = landingOwners.length > 0 ? await deps.blockedStates(landingOwners) : new Map<string, boolean>();

  const settlements = Object.values(
    await deps.largestSettlementOverHold(ids, new Date(deps.now().getTime() - SETTLEMENT_LOOKBACK_MS))
  );

  const signals: Signal[] = [
    { key: 'maxSameSignupIpAccounts', value: Math.max(0, ...signupIpLinks.map(links => links.length)) },
    {
      key: 'sameSignupIpBlockedAccounts',
      value: blockedSignupIpLinks.reduce((sum, hours) => sum + hours.length, 0),
    },
    // Hours between a member's signup and the closest blocked account on its signup IP.
    { key: 'hoursToBlockedSignupIpAccount', value: minOf(blockedSignupIpLinks.flat()) },
    {
      key: 'sameCardAccounts',
      value: Math.max(0, ...linksPerMember.map(({ links }) => links.filter(link => link.via.includes('card')).length)),
    },
    { key: 'landedOnOtherAccountNotebook', value: landingOwners.length > 0 },
    { key: 'landedOnBlockedAccountNotebook', value: landingOwners.some(owner => ownerBlocked.get(owner) === true) },
    {
      key: 'maxSettlementOverHoldRatio',
      value: settlements.length > 0 ? Math.round(Math.max(...settlements.map(s => s.ratio)) * 100) / 100 : null,
    },
    {
      key: 'maxSettlementOverHoldCredits',
      value: settlements.length > 0 ? Math.max(...settlements.map(s => s.settledCredits - s.reservedCredits)) : null,
    },
    { key: 'oauthSignups', value: facts.filter(fact => !EMAIL_SIGNUP_METHODS.has(fact.signupMethod)).length },
    { key: 'emailSignups', value: facts.filter(fact => EMAIL_SIGNUP_METHODS.has(fact.signupMethod)).length },
    { key: 'datacenterSignups', value: facts.filter(fact => fact.signupDatacenter === true).length },
  ];

  return {
    source: LINKED_ACCOUNT_EVIDENCE_SOURCE,
    version: LINKED_ACCOUNT_EVIDENCE_VERSION,
    memberCount: ids.length,
    memberRefs: ids.map(refFor).filter((ref): ref is string => ref !== null),
    signals,
  };
}

/** The live producer for abuseAssessment's group evidence seam. */
export const linkedAccountGroupEvidence: AbuseAssessmentGroupEvidenceSource = ({ detection, refFor }) =>
  buildLinkedAccountEvidence(detection.userIds, refFor);
