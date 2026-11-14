import crypto from 'crypto';
import { Resolver } from 'dns/promises';
import {
  BadRequestError,
  hasOrgPermission,
  ConflictError,
  ForbiddenError,
  DISALLOWED_SIGNUP_RULE_DOMAINS,
  MAX_ORG_DOMAIN_CLAIMS,
  NotFoundError,
  normalizeSignupRuleDomain,
  orgDomainPathIdSchema,
  ORG_DOMAIN_MEMBER_PERMISSIONS,
  organizationSeatUsage,
  type IOrgDomainClaimDocument,
  type IOrgDomainClaimView,
  type IOrganizationDocument,
  type OrgAuthorityActor,
  type OrgDomainJoinSuggestion,
  type UpdateOrgDomainPolicyInput,
} from '@bike4mind/common';
import {
  disposableDomainRepository,
  organizationRepository,
  orgDomainClaimRepository,
  partnerSignupRuleRepository,
  userRepository,
} from '@bike4mind/database';
import { organizationService, userService } from '@bike4mind/services';
import { isSelfHost } from '@bike4mind/server-utils/utils/trustedClientIpHeaders';

export const TXT_RECORD_PREFIX = '_b4m-verify';
const TXT_VALUE_PREFIX = 'b4m-domain-verification=';
const DNS_TIMEOUT_MS = 5000;

export const recordNameFor = (domain: string) => `${TXT_RECORD_PREFIX}.${domain}`;
export const recordValueFor = (token: string) => `${TXT_VALUE_PREFIX}${token}`;

/** Resolves a TXT name to its records; each record is the list of its character-string chunks. */
export type TxtResolver = (name: string) => Promise<string[][]>;

export const defaultTxtResolver: TxtResolver = name => {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  return resolver.resolveTxt(name);
};

/**
 * Local-only stub for the e2e run: answers every name with the claim's own expected record. Needs
 * B4M_DOMAIN_VERIFY_STUB=1 on a local dev runtime (IS_LOCAL or NODE_ENV development); never on self-host.
 */
function stubEnabled(): boolean {
  if (process.env.B4M_DOMAIN_VERIFY_STUB !== '1' || isSelfHost()) return false;
  return process.env.IS_LOCAL === 'true' || process.env.NODE_ENV === 'development';
}

export function getTxtResolver(claim: Pick<IOrgDomainClaimDocument, 'verificationToken'>): TxtResolver {
  if (stubEnabled()) return async () => [[recordValueFor(claim.verificationToken)]];
  return defaultTxtResolver;
}

/** A disabled partner rule routes nothing at signup (getRulesMap loads enabled rules only), so it reserves nothing. */
async function enabledPartnerRule(domain: string) {
  const rule = await partnerSignupRuleRepository.findByDomain(domain);
  return rule?.enabled ? rule : null;
}

function sameOrganizationId(left: string, right: string): boolean {
  const first = orgDomainPathIdSchema.safeParse(left);
  const second = orgDomainPathIdSchema.safeParse(right);
  return first.success && second.success && first.data === second.data;
}

/** Rules every claim must pass on add, and again on verify (state can change in between). */
async function assertDomainClaimable(organizationId: string, domain: string): Promise<void> {
  const verified = await orgDomainClaimRepository.findVerifiedByDomain(domain);
  if (verified && !sameOrganizationId(verified.organizationId, organizationId)) {
    throw new ConflictError('Domain already claimed by another organization');
  }
  // A platform partner rule that routes this domain into another org owns the domain's joins.
  const partnerRule = await enabledPartnerRule(domain);
  if (partnerRule?.organizationId && !sameOrganizationId(partnerRule.organizationId, organizationId)) {
    throw new ConflictError('Domain is reserved by a platform signup rule');
  }
}

export async function addDomainClaim(
  rawOrganizationId: string,
  actorId: string,
  rawDomain: string
): Promise<IOrgDomainClaimDocument> {
  const organizationId = orgDomainPathIdSchema.parse(rawOrganizationId);
  const domain = normalizeSignupRuleDomain(rawDomain);
  if (DISALLOWED_SIGNUP_RULE_DOMAINS.includes(domain)) {
    throw new BadRequestError('Public mail providers cannot be claimed');
  }
  const disposableSources = await disposableDomainRepository.disposableSources([domain]);
  if (disposableSources.length > 0 || userService.isDisposableEmail(`user@${domain}`)) {
    throw new BadRequestError('Disposable email domains cannot be claimed');
  }
  await assertDomainClaimable(organizationId, domain);
  const existingClaims = await orgDomainClaimRepository.listByOrganization(organizationId);
  if (existingClaims.some(claim => claim.domain === domain)) {
    throw new ConflictError('This organization has already added that domain');
  }
  if (existingClaims.length >= MAX_ORG_DOMAIN_CLAIMS) {
    throw new BadRequestError(`An organization can claim at most ${MAX_ORG_DOMAIN_CLAIMS} domains`);
  }

  try {
    return await orgDomainClaimRepository.create({
      organizationId,
      domain,
      status: 'pending',
      verificationToken: crypto.randomBytes(16).toString('hex'),
      verifiedAt: null,
      policy: 'off',
      createdBy: actorId,
    });
  } catch (err) {
    if ((err as { code?: unknown })?.code === 11000) {
      throw new ConflictError('This organization has already added that domain');
    }
    throw err;
  }
}

export type VerifyDomainClaimResult =
  { verified: true; claim: IOrgDomainClaimDocument } | { verified: false; reason: string };

function lookupFailureReason(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (code === 'ENOTFOUND' || code === 'ENODATA') return 'No TXT record found yet';
  if (code === 'ETIMEOUT') return 'DNS lookup timed out';
  return 'DNS lookup failed';
}

/**
 * Proves DNS control of the claim's exact domain (no subdomain or parent inheritance) by matching
 * the TXT record at `recordNameFor(domain)`. Re-verifying an already verified claim is a no-op success.
 */
export async function verifyDomainClaim(
  rawOrganizationId: string,
  claimId: string,
  resolver?: TxtResolver
): Promise<VerifyDomainClaimResult> {
  const organizationId = orgDomainPathIdSchema.parse(rawOrganizationId);
  const claim = await orgDomainClaimRepository.findByIdForOrg(claimId, organizationId);
  if (!claim) throw new NotFoundError('Domain claim not found');
  if (claim.status === 'verified') return { verified: true, claim };

  await assertDomainClaimable(organizationId, claim.domain);

  const resolve = resolver ?? getTxtResolver(claim);
  let records: string[][];
  try {
    records = await resolve(recordNameFor(claim.domain));
  } catch (err) {
    return { verified: false, reason: lookupFailureReason(err) };
  }
  const expected = recordValueFor(claim.verificationToken);
  if (!records.some(chunks => chunks.join('') === expected)) {
    return { verified: false, reason: 'TXT record does not match the expected value' };
  }

  const result = await orgDomainClaimRepository.markVerified(claimId, organizationId);
  if (result === 'conflict') throw new ConflictError('Domain already claimed by another organization');
  if (!result) throw new NotFoundError('Domain claim not found');
  return { verified: true, claim: result };
}

export function toOrgDomainClaimView(claim: IOrgDomainClaimDocument): IOrgDomainClaimView {
  const pending = claim.status !== 'verified';
  return {
    id: claim.id,
    domain: claim.domain,
    status: claim.status,
    verifiedAt: claim.verifiedAt ?? null,
    policy: claim.policy,
    createdAt: claim.createdAt,
    recordName: pending ? recordNameFor(claim.domain) : null,
    recordValue: pending ? recordValueFor(claim.verificationToken) : null,
  };
}

/** Loads the org and enforces the domain-admin gate before any claim is read. */
export async function loadOrgForDomainAdmin(
  actor: OrgAuthorityActor,
  organizationId: string
): Promise<IOrganizationDocument> {
  const organization = await organizationRepository.findById(organizationId);
  if (!organization) throw new NotFoundError('Organization not found');
  if (!hasOrgPermission(actor, organization, 'manageMembers')) {
    throw new ForbiddenError('Only an organization owner or manager can manage domains');
  }
  if (organization.personal) throw new BadRequestError('Personal organizations cannot claim domains');
  return organization;
}

/** A join policy other than 'off' needs a verified claim. */
export async function updateDomainClaimPolicy(
  rawOrganizationId: string,
  claimId: string,
  update: UpdateOrgDomainPolicyInput
): Promise<{ before: IOrgDomainClaimDocument; after: IOrgDomainClaimDocument }> {
  const organizationId = orgDomainPathIdSchema.parse(rawOrganizationId);
  const before = await orgDomainClaimRepository.findByIdForOrg(claimId, organizationId);
  if (!before) throw new NotFoundError('Domain claim not found');
  if (update.policy !== 'off' && before.status !== 'verified') {
    throw new BadRequestError('Verify the domain before turning on a join policy');
  }
  const after = await orgDomainClaimRepository.updatePolicy(claimId, organizationId, update);
  if (!after) throw new NotFoundError('Domain claim not found');
  return { before, after };
}

export type OrgDomainMembershipOutcome =
  | { joined: true; organizationId: string }
  | {
      joined: false;
      reason: 'no-claim' | 'not-auto-join' | 'user-missing' | 'unverified' | 'org-missing' | 'already-member';
    }
  | { joined: false; reason: 'at-capacity'; organizationId: string; seats: number };

/** The exact domain after the last '@', or '' when there is none. */
function emailDomain(email: string | null | undefined): string {
  if (!email) return '';
  const at = email.lastIndexOf('@');
  return at >= 0
    ? email
        .slice(at + 1)
        .trim()
        .toLowerCase()
    : '';
}

type DomainJoinUser = {
  id: string;
  email?: string | null;
  username: string;
  name: string;
  organizationId?: string | null;
};

/**
 * Adds the user to the claim's org as a read-only member, never raising the seat ceiling.
 * The membership shape (a `users[]` row, `user.organizationId`, a seeded `userDetails` row) must stay
 * in sync with applyPartnerRuleMembership (b4m-core/services organizationService).
 */
async function addMemberViaClaim(
  claim: IOrgDomainClaimDocument,
  user: DomainJoinUser
): Promise<
  Exclude<OrgDomainMembershipOutcome, { reason: 'no-claim' | 'not-auto-join' | 'user-missing' | 'unverified' }>
> {
  const { organizationId } = claim;
  const permissions = [...ORG_DOMAIN_MEMBER_PERMISSIONS];
  const pre = await organizationRepository.addMemberIfUnderCeiling(organizationId, { userId: user.id, permissions });
  if (!pre) {
    const fresh = await organizationRepository.findById(organizationId);
    if (!fresh) return { joined: false, reason: 'org-missing' };
    if (fresh.users.some(member => member.userId === user.id)) {
      await repairDomainMembership(user, organizationId);
      return { joined: false, reason: 'already-member' };
    }
    return { joined: false, reason: 'at-capacity', organizationId, seats: fresh.seats };
  }

  await userRepository.update({ id: user.id, organizationId });
  await seedDomainMemberDetails(user, organizationId);
  return { joined: true, organizationId };
}

function seedDomainMemberDetails(user: DomainJoinUser, organizationId: string) {
  return organizationRepository.ensureUserDetails(organizationId, {
    id: user.id,
    email: user.email ?? user.username,
    name: user.name,
  });
}

/**
 * Completes a join that wrote the `users[]` row but failed before the org pointer or the
 * `userDetails` row, so a retry repairs it instead of stopping at already-member. Both writes are
 * idempotent; mirrors the already-member repair in applyPartnerRuleMembership.
 */
async function repairDomainMembership(user: DomainJoinUser, organizationId: string): Promise<void> {
  if (user.organizationId !== organizationId) await userRepository.update({ id: user.id, organizationId });
  await seedDomainMemberDetails(user, organizationId);
}

const holdsMemberRow = (organization: IOrganizationDocument, userId: string) =>
  (organization.users ?? []).some(member => member.userId?.toString() === userId);

/** Auto-join for a verified 'auto-join' claim on the email's exact domain (a subdomain never matches). */
export async function applyOrgDomainMembership(userId: string, email: string): Promise<OrgDomainMembershipOutcome> {
  const domain = emailDomain(email);
  if (!domain) return { joined: false, reason: 'no-claim' };

  const claim = await orgDomainClaimRepository.findVerifiedJoinableByDomain(domain);
  if (!claim) return { joined: false, reason: 'no-claim' };
  if (claim.policy !== 'auto-join') return { joined: false, reason: 'not-auto-join' };

  // Re-read rather than trust the caller's copy, which may predate email verification.
  const user = await userRepository.findById(userId);
  if (!user) return { joined: false, reason: 'user-missing' };
  if (user.emailVerified !== true) return { joined: false, reason: 'unverified' };

  const organization = await organizationRepository.findById(claim.organizationId);
  if (!organization) return { joined: false, reason: 'org-missing' };
  // Checked first: the owner holds no users[] row, so the atomic add alone would not see them.
  if (organizationService.isCurrentOrgMember(organization, userId)) {
    if (holdsMemberRow(organization, userId)) await repairDomainMembership(user, organization.id);
    return { joined: false, reason: 'already-member' };
  }

  return addMemberViaClaim({ ...claim, organizationId: organization.id }, user);
}

/**
 * The verified, joinable claim on the email's exact domain, unless a partner rule routes that domain
 * into a different org (partner rules take precedence, as at signup).
 */
async function joinableClaimForEmail(email: string | null | undefined): Promise<IOrgDomainClaimDocument | null> {
  const domain = emailDomain(email);
  if (!domain) return null;
  const claim = await orgDomainClaimRepository.findVerifiedJoinableByDomain(domain);
  if (!claim) return null;
  const partnerRule = await enabledPartnerRule(domain);
  if (partnerRule?.organizationId && !sameOrganizationId(partnerRule.organizationId, claim.organizationId)) return null;
  return claim;
}

/**
 * Orgs an existing user may join through their verified email's domain (policy 'suggest' or
 * 'auto-join'). Omits orgs the user is already in and orgs with no free seat.
 */
export async function listOrgDomainJoinSuggestions(userId: string): Promise<OrgDomainJoinSuggestion[]> {
  const user = await userRepository.findById(userId);
  if (!user || user.emailVerified !== true) return [];
  const claim = await joinableClaimForEmail(user.email);
  if (!claim) return [];
  const organization = await organizationRepository.findById(claim.organizationId);
  if (!organization) return [];
  if (organizationService.isCurrentOrgMember(organization, userId)) return [];
  if (organizationSeatUsage(organization).full) return [];
  return [{ organizationId: organization.id, organizationName: organization.name, claimId: claim.id }];
}

/**
 * Joins an existing user to `organizationId` on request. Re-derives eligibility from the user's
 * current verified email and the org's live claim; nothing from the client is trusted.
 */
export async function joinOrgViaDomain(
  userId: string,
  rawOrganizationId: string
): Promise<{ joined: boolean; organization: IOrganizationDocument }> {
  const organizationId = orgDomainPathIdSchema.parse(rawOrganizationId);
  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  if (user.emailVerified !== true) throw new ForbiddenError('Verify your email address before joining');

  const claim = await joinableClaimForEmail(user.email);
  if (!claim || !sameOrganizationId(claim.organizationId, organizationId)) {
    throw new ForbiddenError('Your email domain does not grant access to this organization');
  }
  const organization = await organizationRepository.findById(organizationId);
  if (!organization) throw new NotFoundError('Organization not found');
  // Checked first: the owner holds no users[] row, so the atomic add alone would not see them.
  if (organizationService.isCurrentOrgMember(organization, userId)) {
    if (holdsMemberRow(organization, userId)) await repairDomainMembership(user, organizationId);
    return { joined: false, organization };
  }

  const outcome = await addMemberViaClaim({ ...claim, organizationId: organization.id }, user);
  if (outcome.joined) return { joined: true, organization };
  if (outcome.reason === 'already-member') return { joined: false, organization };
  if (outcome.reason === 'org-missing') throw new NotFoundError('Organization not found');
  throw new ConflictError('Organization is at full capacity');
}
