import crypto from 'crypto';
import { Resolver } from 'dns/promises';
import {
  BadRequestError,
  canAdministerOrganization,
  ConflictError,
  ForbiddenError,
  DISALLOWED_SIGNUP_RULE_DOMAINS,
  InboxType,
  MAX_ORG_DOMAIN_CLAIMS,
  NotFoundError,
  normalizeSignupRuleDomain,
  orgDomainPathIdSchema,
  ORG_DOMAIN_MEMBER_PERMISSIONS,
  organizationSeatUsage,
  type IOrgDomainClaimDocument,
  type IOrgDomainClaimView,
  type IOrganizationDocument,
  type ISpaceDocument,
  type OrgAuthorityActor,
  type OrgDomainClaimOwner,
  type OrgDomainJoinSuggestion,
  type UpdateOrgDomainPolicyInput,
  type UpdateSpaceDomainPolicyInput,
} from '@bike4mind/common';
import {
  disposableDomainRepository,
  inboxRepository,
  organizationRepository,
  orgDomainClaimRepository,
  partnerSignupRuleRepository,
  spaceRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { organizationService, userService } from '@bike4mind/services';
import { isSelfHost } from '@bike4mind/server-utils/utils/trustedClientIpHeaders';
import { notifySpaceDomainReleasedByEmail } from '@server/utils/spaceDomainNotifier';

const logger = new Logger({ metadata: { service: 'orgDomainClaims' } });

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

type OrgDomainClaim = IOrgDomainClaimDocument & { organizationId: string };

const isOrgClaim = (claim: IOrgDomainClaimDocument): claim is OrgDomainClaim => claim.organizationId !== undefined;

function sameOrganizationId(left: string, right: string): boolean {
  const first = orgDomainPathIdSchema.safeParse(left);
  const second = orgDomainPathIdSchema.safeParse(right);
  return first.success && second.success && first.data === second.data;
}

/**
 * Rules every claim must pass on add, and again on verify (state can change in between). An org
 * outranks a Space: a verified Space holder does not block an org, which takes the domain at verify.
 */
async function assertDomainClaimable(owner: OrgDomainClaimOwner, domain: string): Promise<void> {
  const verified = await orgDomainClaimRepository.findVerifiedByDomain(domain);
  if (verified) {
    if (isOrgClaim(verified)) {
      const sameOrg =
        owner.organizationId !== undefined && sameOrganizationId(verified.organizationId, owner.organizationId);
      if (!sameOrg) {
        throw new ConflictError(
          owner.organizationId !== undefined
            ? 'Domain already claimed by another organization'
            : 'Domain already claimed by an organization'
        );
      }
    } else if (owner.spaceId !== undefined && verified.spaceId !== owner.spaceId) {
      throw new ConflictError('Domain already claimed by another Space');
    }
  }
  // A platform partner rule that routes this domain into an org owns the domain's joins.
  const partnerRule = await enabledPartnerRule(domain);
  if (
    partnerRule?.organizationId &&
    (owner.organizationId === undefined || !sameOrganizationId(partnerRule.organizationId, owner.organizationId))
  ) {
    throw new ConflictError('Domain is reserved by a platform signup rule');
  }
}

const claimsOf = (owner: OrgDomainClaimOwner) =>
  owner.organizationId !== undefined
    ? orgDomainClaimRepository.listByOrganization(owner.organizationId)
    : orgDomainClaimRepository.listBySpace(owner.spaceId);

const findClaimOf = (claimId: string, owner: OrgDomainClaimOwner) =>
  owner.organizationId !== undefined
    ? orgDomainClaimRepository.findByIdForOrg(claimId, owner.organizationId)
    : orgDomainClaimRepository.findByIdForSpace(claimId, owner.spaceId);

const ownerLabel = (owner: OrgDomainClaimOwner) => (owner.organizationId !== undefined ? 'organization' : 'Space');

async function addClaimForOwner(
  owner: OrgDomainClaimOwner,
  actorId: string,
  rawDomain: string
): Promise<IOrgDomainClaimDocument> {
  const domain = normalizeSignupRuleDomain(rawDomain);
  if (DISALLOWED_SIGNUP_RULE_DOMAINS.includes(domain)) {
    throw new BadRequestError('Public mail providers cannot be claimed');
  }
  const disposableSources = await disposableDomainRepository.disposableSources([domain]);
  if (disposableSources.length > 0 || userService.isDisposableEmail(`user@${domain}`)) {
    throw new BadRequestError('Disposable email domains cannot be claimed');
  }
  await assertDomainClaimable(owner, domain);
  const existingClaims = await claimsOf(owner);
  if (existingClaims.some(claim => claim.domain === domain)) {
    throw new ConflictError(`This ${ownerLabel(owner)} has already added that domain`);
  }
  if (existingClaims.length >= MAX_ORG_DOMAIN_CLAIMS) {
    const subject = owner.organizationId !== undefined ? 'An organization' : 'A Space';
    throw new BadRequestError(`${subject} can claim at most ${MAX_ORG_DOMAIN_CLAIMS} domains`);
  }

  try {
    return await orgDomainClaimRepository.create({
      ...owner,
      domain,
      status: 'pending',
      verificationToken: crypto.randomBytes(16).toString('hex'),
      verifiedAt: null,
      policy: 'off',
      createdBy: actorId,
    });
  } catch (err) {
    if ((err as { code?: unknown })?.code === 11000) {
      throw new ConflictError(`This ${ownerLabel(owner)} has already added that domain`);
    }
    throw err;
  }
}

export function addDomainClaim(
  rawOrganizationId: string,
  actorId: string,
  rawDomain: string
): Promise<IOrgDomainClaimDocument> {
  return addClaimForOwner({ organizationId: orgDomainPathIdSchema.parse(rawOrganizationId) }, actorId, rawDomain);
}

export function addSpaceDomainClaim(
  spaceId: string,
  actorId: string,
  rawDomain: string
): Promise<IOrgDomainClaimDocument> {
  return addClaimForOwner({ spaceId }, actorId, rawDomain);
}

export type VerifyDomainClaimResult =
  { verified: true; claim: IOrgDomainClaimDocument } | { verified: false; reason: string };

function lookupFailureReason(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (code === 'ENOTFOUND' || code === 'ENODATA') return 'No TXT record found yet';
  if (code === 'ETIMEOUT') return 'DNS lookup timed out';
  return 'DNS lookup failed';
}

/** Inbox notice to a Space owner. Best-effort: the release has already committed. */
async function notifyOwnerInbox(receiverId: string, title: string, message: string): Promise<void> {
  try {
    await inboxRepository.createInboxMessage({ type: InboxType.COMMON, title, message, receiverId, userId: 'SYSTEM' });
  } catch (error) {
    logger.error(`[SPACE_DOMAIN] inbox notice failed receiver=${receiverId}`, error);
  }
}

/** Tells each released Space's owner. Names the Space and the domain, never the org that took it. */
async function notifyReleasedSpaceOwners(released: IOrgDomainClaimDocument[]): Promise<void> {
  for (const claim of released) {
    try {
      const space = claim.spaceId ? await spaceRepository.findLiveById(claim.spaceId) : null;
      if (!space) continue;
      await notifyOwnerInbox(
        space.ownerUserId,
        `${space.name} no longer holds ${claim.domain}`,
        `Another party verified ownership of ${claim.domain}, so your Space no longer holds it. ` +
          'People who already joined through that domain stay. New domain joins have stopped.'
      );
      await notifySpaceDomainReleasedByEmail(space.ownerUserId, space.name, claim.domain, logger);
    } catch (error) {
      logger.error(`[SPACE_DOMAIN] release notice failed space=${claim.spaceId}`, error);
    }
  }
}

/**
 * Proves DNS control of the claim's exact domain (no subdomain or parent inheritance) by matching
 * the TXT record at `recordNameFor(domain)`. Re-verifying an already verified claim is a no-op success.
 */
async function verifyClaimForOwner(
  owner: OrgDomainClaimOwner,
  claimId: string,
  resolver?: TxtResolver
): Promise<VerifyDomainClaimResult> {
  const claim = await findClaimOf(claimId, owner);
  if (!claim) throw new NotFoundError('Domain claim not found');
  if (claim.status === 'verified') return { verified: true, claim };

  await assertDomainClaimable(owner, claim.domain);

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

  // An org outranks a Space: its verify releases the Space claims on the domain in the same
  // transaction, so the one-verified-holder index never sees both.
  const { result, released } = await withTransaction(async () => {
    const released =
      owner.organizationId !== undefined ? await orgDomainClaimRepository.deleteSpaceClaimsByDomain(claim.domain) : [];
    return { result: await orgDomainClaimRepository.markVerified(claimId, owner), released };
  });
  if (result === 'conflict') {
    throw new ConflictError(
      owner.organizationId !== undefined
        ? 'Domain already claimed by another organization'
        : 'Domain already claimed by another owner'
    );
  }
  if (!result) throw new NotFoundError('Domain claim not found');
  await notifyReleasedSpaceOwners(released);
  return { verified: true, claim: result };
}

export function verifyDomainClaim(
  rawOrganizationId: string,
  claimId: string,
  resolver?: TxtResolver
): Promise<VerifyDomainClaimResult> {
  return verifyClaimForOwner({ organizationId: orgDomainPathIdSchema.parse(rawOrganizationId) }, claimId, resolver);
}

export function verifySpaceDomainClaim(
  spaceId: string,
  claimId: string,
  resolver?: TxtResolver
): Promise<VerifyDomainClaimResult> {
  return verifyClaimForOwner({ spaceId }, claimId, resolver);
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
  if (!canAdministerOrganization(actor, organization)) {
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

/** Same gate as the org policy update. A Space never takes `auto-join`, so the input type excludes it. */
export async function updateSpaceDomainClaimPolicy(
  spaceId: string,
  claimId: string,
  update: UpdateSpaceDomainPolicyInput
): Promise<{ before: IOrgDomainClaimDocument; after: IOrgDomainClaimDocument }> {
  const before = await orgDomainClaimRepository.findByIdForSpace(claimId, spaceId);
  if (!before) throw new NotFoundError('Domain claim not found');
  if (update.policy !== 'off' && before.status !== 'verified') {
    throw new BadRequestError('Verify the domain before turning on a join policy');
  }
  const after = await orgDomainClaimRepository.updatePolicyForSpace(claimId, spaceId, update);
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
  claim: OrgDomainClaim,
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
  if (!claim || !isOrgClaim(claim)) return { joined: false, reason: 'no-claim' };
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
async function joinableClaimForEmail(email: string | null | undefined): Promise<OrgDomainClaim | null> {
  const domain = emailDomain(email);
  if (!domain) return null;
  const claim = await orgDomainClaimRepository.findVerifiedJoinableByDomain(domain);
  if (!claim || !isOrgClaim(claim)) return null;
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

async function ownerAdministersParent(space: ISpaceDocument, organizationId: string): Promise<boolean> {
  const [owner, organization] = await Promise.all([
    userRepository.findById(space.ownerUserId),
    organizationRepository.findById(organizationId),
  ]);
  return Boolean(owner && organization && canAdministerOrganization(owner, organization));
}

/**
 * A Space's joinable domains are its own verified `suggest` claim and its parent org's verified,
 * joinable claim. Inheritance holds only while the Space's current owner administers that parent,
 * re-checked here at read time.
 */
export async function isDomainJoinable(space: ISpaceDocument, email: string): Promise<boolean> {
  const domain = emailDomain(email);
  if (!domain) return false;
  const own = await orgDomainClaimRepository.findVerifiedSpaceClaimByDomain(domain);
  if (own?.spaceId === space.id) return true;
  if (!space.parentOrganizationId) return false;
  const inherited = await joinableClaimForEmail(email);
  if (!inherited || !sameOrganizationId(inherited.organizationId, space.parentOrganizationId)) return false;
  return ownerAdministersParent(space, space.parentOrganizationId);
}

/** Ids of the Spaces the address may join: its own `suggest` claim, plus child Spaces of a joinable org claim. */
export async function joinableSpaceIdsForEmail(email: string): Promise<string[]> {
  const domain = emailDomain(email);
  if (!domain) return [];
  const ids = new Set<string>();
  const own = await orgDomainClaimRepository.findVerifiedSpaceClaimByDomain(domain);
  if (own?.spaceId) ids.add(own.spaceId);

  const inherited = await joinableClaimForEmail(email);
  if (inherited) {
    const children = await spaceRepository.listLiveByParentOrganization(inherited.organizationId);
    for (const space of children) {
      if (await ownerAdministersParent(space, inherited.organizationId)) ids.add(space.id);
    }
  }
  return [...ids];
}
