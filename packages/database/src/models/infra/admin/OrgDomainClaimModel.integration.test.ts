import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrgDomainClaim, orgDomainClaimRepository } from './OrgDomainClaimModel';
import { setupMongoTest } from '../../../__test__/utils';

const ORG_A = 'a'.repeat(24);
const ORG_B = 'b'.repeat(24);

const createClaim = (organizationId: string, domain = 'acme.com') =>
  orgDomainClaimRepository.create({
    organizationId,
    domain,
    status: 'pending',
    verificationToken: `token-${organizationId}`,
    verifiedAt: null,
    policy: 'off',
    createdBy: null,
  });

describe('OrgDomainClaimModel', () => {
  setupMongoTest();

  beforeEach(async () => {
    await OrgDomainClaim.deleteMany({});
    await OrgDomainClaim.syncIndexes();
  });

  it('normalizes the domain on write', async () => {
    const claim = await createClaim(ORG_A, '  ACME.com ');
    expect(claim.domain).toBe('acme.com');
  });

  it('allows two orgs to hold pending claims on the same domain', async () => {
    await createClaim(ORG_A);
    await expect(createClaim(ORG_B)).resolves.toBeTruthy();
  });

  it('rejects a duplicate (org, domain) claim', async () => {
    await createClaim(ORG_A);
    await expect(createClaim(ORG_A, 'ACME.COM')).rejects.toMatchObject({ code: 11000 });
  });

  it('lets only one org verify a domain; the second verify reports a conflict', async () => {
    const a = await createClaim(ORG_A);
    const b = await createClaim(ORG_B);

    const first = await orgDomainClaimRepository.markVerified(String(a.id), ORG_A);
    expect(first).toMatchObject({ status: 'verified' });

    expect(await orgDomainClaimRepository.markVerified(String(b.id), ORG_B)).toBe('conflict');
    expect(await OrgDomainClaim.findById(b.id).lean()).toMatchObject({ status: 'pending', verifiedAt: null });
  });

  it('settles concurrent verifies with exactly one winner', async () => {
    const a = await createClaim(ORG_A);
    const b = await createClaim(ORG_B);

    const results = await Promise.all([
      orgDomainClaimRepository.markVerified(String(a.id), ORG_A),
      orgDomainClaimRepository.markVerified(String(b.id), ORG_B),
    ]);

    expect(results.filter(result => result === 'conflict')).toHaveLength(1);
    expect(await OrgDomainClaim.countDocuments({ domain: 'acme.com', status: 'verified' })).toBe(1);
  });

  it('keeps the original verifiedAt on a re-verify', async () => {
    const a = await createClaim(ORG_A);
    const first = await orgDomainClaimRepository.markVerified(String(a.id), ORG_A);
    const again = await orgDomainClaimRepository.markVerified(String(a.id), ORG_A);
    expect(first).not.toBe('conflict');
    expect(again).not.toBe('conflict');
    expect((again as { verifiedAt: Date }).verifiedAt).toEqual((first as { verifiedAt: Date }).verifiedAt);
  });

  it('scopes id lookups and mutations to the owning org', async () => {
    const a = await createClaim(ORG_A);
    const id = String(a.id);

    expect(await orgDomainClaimRepository.findByIdForOrg(id, ORG_B)).toBeNull();
    expect(await orgDomainClaimRepository.markVerified(id, ORG_B)).toBeNull();
    expect(await orgDomainClaimRepository.updatePolicy(id, ORG_B, { policy: 'auto-join' })).toBeNull();
    expect(await orgDomainClaimRepository.deleteForOrg(id, ORG_B)).toBe(false);
    expect(await orgDomainClaimRepository.findByIdForOrg('not-an-id', ORG_A)).toBeNull();
    expect(await orgDomainClaimRepository.findByIdForOrg(id, ORG_A)).toMatchObject({ domain: 'acme.com' });
  });

  it('only returns verified claims with a policy other than off as joinable', async () => {
    const a = await createClaim(ORG_A);
    const id = String(a.id);
    expect(await orgDomainClaimRepository.findVerifiedJoinableByDomain('acme.com')).toBeNull();

    await orgDomainClaimRepository.markVerified(id, ORG_A);
    expect(await orgDomainClaimRepository.findVerifiedByDomain('ACME.COM')).toMatchObject({ organizationId: ORG_A });
    expect(await orgDomainClaimRepository.findVerifiedJoinableByDomain('acme.com')).toBeNull();

    await orgDomainClaimRepository.updatePolicy(id, ORG_A, { policy: 'suggest' });
    expect(await orgDomainClaimRepository.findVerifiedJoinableByDomain('acme.com')).toMatchObject({
      policy: 'suggest',
    });
  });

  it('ensures indexes are built before it marks a claim verified', async () => {
    const claim = await createClaim(ORG_A);
    const init = vi.spyOn(OrgDomainClaim, 'init');
    const update = vi.spyOn(OrgDomainClaim, 'findOneAndUpdate');
    try {
      await orgDomainClaimRepository.markVerified(String(claim.id), ORG_A);
      expect(init).toHaveBeenCalledTimes(1);
      expect(init.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]);
    } finally {
      init.mockRestore();
      update.mockRestore();
    }
  });

  it('deletes every claim of an organization', async () => {
    await createClaim(ORG_A, 'acme.com');
    await createClaim(ORG_A, 'acme.org');
    await createClaim(ORG_B, 'acme.com');

    expect(await orgDomainClaimRepository.deleteByOrganization(ORG_A)).toBe(2);
    expect(await orgDomainClaimRepository.countByOrganization(ORG_B)).toBe(1);
  });
  it('uses ordinary updates and preserves the first date across concurrent re-verification', async () => {
    const claim = await createClaim(ORG_A);
    const updates = vi.spyOn(OrgDomainClaim, 'findOneAndUpdate');
    try {
      const first = await orgDomainClaimRepository.markVerified(String(claim.id), ORG_A);
      if (!first || first === 'conflict') throw new Error('Expected initial verification');
      const results = await Promise.all(
        Array.from({ length: 3 }, () => orgDomainClaimRepository.markVerified(String(claim.id), ORG_A))
      );
      for (const result of results) expect(result).toMatchObject({ status: 'verified', verifiedAt: first.verifiedAt });
      // DocumentDB 5 supports update documents, not this feature's former aggregation-update stage.
      expect(updates).toHaveBeenCalled();
      for (const [filter, update] of updates.mock.calls) {
        expect(filter).toMatchObject({ _id: String(claim.id), organizationId: ORG_A });
        expect(Array.isArray(update)).toBe(false);
      }
    } finally {
      updates.mockRestore();
    }
  });

  it('preserves a historical date on a pending row and initializes an absent date', async () => {
    const claim = await createClaim(ORG_A);
    const first = new Date('2026-01-01T00:00:00Z');
    await OrgDomainClaim.updateOne({ _id: claim.id }, { $set: { verifiedAt: first } });
    expect(await orgDomainClaimRepository.markVerified(String(claim.id), ORG_A)).toMatchObject({
      verifiedAt: first,
      status: 'verified',
    });
    await OrgDomainClaim.updateOne({ _id: claim.id }, { $unset: { verifiedAt: 1 } });
    expect(await orgDomainClaimRepository.markVerified(String(claim.id), ORG_A)).toMatchObject({
      verifiedAt: expect.any(Date),
      status: 'verified',
    });
  });
});
