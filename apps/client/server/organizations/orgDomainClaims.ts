import crypto from 'crypto';
import { Resolver } from 'dns/promises';
import {
  BadRequestError,
  canAdministerOrganization,
  ConflictError,
  ForbiddenError,
  DISALLOWED_SIGNUP_RULE_DOMAINS,
  MAX_ORG_DOMAIN_CLAIMS,
  NotFoundError,
  normalizeSignupRuleDomain,
  ORG_DOMAIN_ROLE_PERMISSIONS,
  type IOrgDomainClaimDocument,
  type IOrgDomainClaimView,
  type IOrganizationDocument,
  type OrgAuthorityActor,
  type UpdateOrgDomainPolicyInput,
} from '@bike4mind/common';
import {
  disposableDomainRepository,
  organizationRepository,
  orgDomainClaimRepository,
  partnerSignupRuleRepository,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
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
 * Local-only stub for the e2e run: answers every name with the claim's own expected record. Never
 * active on a hosted or self-host runtime, whatever the env says.
 */
function stubEnabled(): boolean {
  if (process.env.B4M_DOMAIN_VERIFY_STUB !== '1' || isSelfHost()) return false;
  return process.env.IS_LOCAL === 'true' || process.env.NODE_ENV === 'development';
}

export function getTxtResolver(claim: Pick<IOrgDomainClaimDocument, 'verificationToken'>): TxtResolver {
  if (stubEnabled()) return async () => [[recordValueFor(claim.verificationToken)]];
  return defaultTxtResolver;
}

/** Rules every claim must pass on add, and again on verify (state can change in between). */
async function assertDomainClaimable(organizationId: string, domain: string): Promise<void> {
  const verified = await orgDomainClaimRepository.findVerifiedByDomain(domain);
  if (verified && verified.organizationId !== organizationId) {
    throw new ConflictError('Domain already claimed by another organization');
  }
  // A platform partner rule that routes this domain into another org owns the domain's joins.
  const partnerRule = await partnerSignupRuleRepository.findByDomain(domain);
  if (partnerRule?.organizationId && partnerRule.organizationId !== organizationId) {
    throw new ConflictError('Domain is reserved by a platform signup rule');
  }
}

export async function addDomainClaim(
  organizationId: string,
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
  await assertDomainClaimable(organizationId, domain);
  if ((await orgDomainClaimRepository.countByOrganization(organizationId)) >= MAX_ORG_DOMAIN_CLAIMS) {
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
      defaultRole: 'member',
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
  organizationId: string,
  claimId: string,
  resolver?: TxtResolver
): Promise<VerifyDomainClaimResult> {
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
    defaultRole: claim.defaultRole,
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
  return organization;
}

/** A join policy other than 'off' needs a verified claim; the default role may be set any time. */
export async function updateDomainClaimPolicy(
  organizationId: string,
  claimId: string,
  update: UpdateOrgDomainPolicyInput
): Promise<{ before: IOrgDomainClaimDocument; after: IOrgDomainClaimDocument }> {
  const before = await orgDomainClaimRepository.findByIdForOrg(claimId, organizationId);
  if (!before) throw new NotFoundError('Domain claim not found');
  if (update.policy !== undefined && update.policy !== 'off' && before.status !== 'verified') {
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

/**
 * Auto-join for a verified claim with policy 'auto-join' on the email's exact domain (a subdomain
 * never matches its parent). Never raises the seat ceiling. The membership shape (a `users[]` row,
 * `user.organizationId`, a seeded `userDetails` row) must stay in sync with applyPartnerRuleMembership
 * (b4m-core/services organizationService).
 */
export async function applyOrgDomainMembership(userId: string, email: string): Promise<OrgDomainMembershipOutcome> {
  const at = email.lastIndexOf('@');
  const domain =
    at >= 0
      ? email
          .slice(at + 1)
          .trim()
          .toLowerCase()
      : '';
  if (!domain) return { joined: false, reason: 'no-claim' };

  const claim = await orgDomainClaimRepository.findVerifiedJoinableByDomain(domain);
  if (!claim) return { joined: false, reason: 'no-claim' };
  if (claim.policy !== 'auto-join') return { joined: false, reason: 'not-auto-join' };

  // Re-read rather than trust the caller's copy, which may predate email verification.
  const user = await userRepository.findById(userId);
  if (!user) return { joined: false, reason: 'user-missing' };
  if (user.emailVerified !== true) return { joined: false, reason: 'unverified' };

  const { organizationId } = claim;
  const permissions = [...ORG_DOMAIN_ROLE_PERMISSIONS[claim.defaultRole]];
  const pre = await organizationRepository.addMemberIfUnderCeiling(organizationId, { userId, permissions });
  if (!pre) {
    const fresh = await organizationRepository.findById(organizationId);
    if (!fresh) return { joined: false, reason: 'org-missing' };
    if (fresh.users.some(member => member.userId === userId)) return { joined: false, reason: 'already-member' };
    return { joined: false, reason: 'at-capacity', organizationId, seats: fresh.seats };
  }

  await userRepository.update({ id: userId, organizationId });
  await organizationRepository.ensureUserDetails(organizationId, {
    id: user.id,
    email: user.email ?? user.username,
    name: user.name,
  });
  return { joined: true, organizationId };
}
