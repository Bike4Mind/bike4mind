import crypto from 'crypto';
import { Resolver } from 'dns/promises';
import {
  BadRequestError,
  ConflictError,
  DISALLOWED_SIGNUP_RULE_DOMAINS,
  MAX_ORG_DOMAIN_CLAIMS,
  NotFoundError,
  normalizeSignupRuleDomain,
  type IOrgDomainClaimDocument,
} from '@bike4mind/common';
import { disposableDomainRepository, orgDomainClaimRepository, partnerSignupRuleRepository } from '@bike4mind/database';
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
