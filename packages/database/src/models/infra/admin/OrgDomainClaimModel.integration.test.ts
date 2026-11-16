import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
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

    const first = await orgDomainClaimRepository.markVerified(String(a.id), { organizationId: ORG_A });
    expect(first).toMatchObject({ status: 'verified' });

    expect(await orgDomainClaimRepository.markVerified(String(b.id), { organizationId: ORG_B })).toBe('conflict');
    expect(await OrgDomainClaim.findById(b.id).lean()).toMatchObject({ status: 'pending', verifiedAt: null });
  });

  it('settles concurrent verifies with exactly one winner', async () => {
    const a = await createClaim(ORG_A);
    const b = await createClaim(ORG_B);

    const results = await Promise.all([
      orgDomainClaimRepository.markVerified(String(a.id), { organizationId: ORG_A }),
      orgDomainClaimRepository.markVerified(String(b.id), { organizationId: ORG_B }),
    ]);

    expect(results.filter(result => result === 'conflict')).toHaveLength(1);
    expect(await OrgDomainClaim.countDocuments({ domain: 'acme.com', status: 'verified' })).toBe(1);
  });

  it('keeps the original verifiedAt on a re-verify', async () => {
    const a = await createClaim(ORG_A);
    const first = await orgDomainClaimRepository.markVerified(String(a.id), { organizationId: ORG_A });
    const again = await orgDomainClaimRepository.markVerified(String(a.id), { organizationId: ORG_A });
    expect(first).not.toBe('conflict');
    expect(again).not.toBe('conflict');
    expect((again as { verifiedAt: Date }).verifiedAt).toEqual((first as { verifiedAt: Date }).verifiedAt);
  });

  it('scopes id lookups and mutations to the owning org', async () => {
    const a = await createClaim(ORG_A);
    const id = String(a.id);

    expect(await orgDomainClaimRepository.findByIdForOrg(id, ORG_B)).toBeNull();
    expect(await orgDomainClaimRepository.markVerified(id, { organizationId: ORG_B })).toBeNull();
    expect(await orgDomainClaimRepository.updatePolicy(id, ORG_B, { policy: 'auto-join' })).toBeNull();
    expect(await orgDomainClaimRepository.deleteForOrg(id, ORG_B)).toBe(false);
    expect(await orgDomainClaimRepository.findByIdForOrg('not-an-id', ORG_A)).toBeNull();
    expect(await orgDomainClaimRepository.findByIdForOrg(id, ORG_A)).toMatchObject({ domain: 'acme.com' });
  });

  it('only returns verified claims with a policy other than off as joinable', async () => {
    const a = await createClaim(ORG_A);
    const id = String(a.id);
    expect(await orgDomainClaimRepository.findVerifiedJoinableByDomain('acme.com')).toBeNull();

    await orgDomainClaimRepository.markVerified(id, { organizationId: ORG_A });
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
      await orgDomainClaimRepository.markVerified(String(claim.id), { organizationId: ORG_A });
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
      const first = await orgDomainClaimRepository.markVerified(String(claim.id), { organizationId: ORG_A });
      if (!first || first === 'conflict') throw new Error('Expected initial verification');
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          orgDomainClaimRepository.markVerified(String(claim.id), { organizationId: ORG_A })
        )
      );
      for (const result of results) expect(result).toMatchObject({ status: 'verified', verifiedAt: first.verifiedAt });
      // DocumentDB 5 supports update documents, not this feature's former aggregation-update stage.
      expect(updates).toHaveBeenCalled();
      for (const [filter, update] of updates.mock.calls) {
        expect(filter).toMatchObject({
          _id: String(claim.id),
          organizationId: { $regex: `^${ORG_A}$`, $options: 'i' },
        });
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
    expect(await orgDomainClaimRepository.markVerified(String(claim.id), { organizationId: ORG_A })).toMatchObject({
      verifiedAt: first,
      status: 'verified',
    });
    await OrgDomainClaim.updateOne({ _id: claim.id }, { $unset: { verifiedAt: 1 } });
    expect(await orgDomainClaimRepository.markVerified(String(claim.id), { organizationId: ORG_A })).toMatchObject({
      verifiedAt: expect.any(Date),
      status: 'verified',
    });
  });
});

describe('canonical organization IDs and legacy aliases', () => {
  setupMongoTest();
  beforeEach(async () => {
    await OrgDomainClaim.deleteMany({});
    await OrgDomainClaim.syncIndexes();
  });

  it('persists canonical IDs even for a direct uppercase model write', async () => {
    const claim = await createClaim(ORG_A.toUpperCase());
    expect(claim.organizationId).toBe(ORG_A);
    expect(
      (await OrgDomainClaim.collection.findOne({ _id: new mongoose.Types.ObjectId(claim.id) }))?.organizationId
    ).toBe(ORG_A);
  });

  it('finds and modifies case aliases without crossing organization boundaries or rewriting them', async () => {
    const seedLegacy = async (organizationId: string, domain: string) => {
      const inserted = await OrgDomainClaim.collection.insertOne({
        organizationId,
        domain,
        status: 'pending',
        verificationToken: 'legacy-token',
        verifiedAt: null,
        policy: 'off',
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return String(inserted.insertedId);
    };
    const first = await seedLegacy(ORG_A.toUpperCase(), 'legacy-first.example');
    const second = await seedLegacy('Aa'.repeat(12), 'legacy-second.example');
    const other = await createClaim(ORG_B, 'other.example');
    for (const caller of [ORG_A, ORG_A.toUpperCase(), 'Aa'.repeat(12)]) {
      expect(await orgDomainClaimRepository.countByOrganization(caller)).toBe(2);
      const listed = await orgDomainClaimRepository.listByOrganization(caller);
      expect(listed.map(claim => claim.organizationId)).toEqual([ORG_A, ORG_A]);
      expect(await orgDomainClaimRepository.findByIdForOrg(first, caller)).toMatchObject({ organizationId: ORG_A });
    }
    expect(await orgDomainClaimRepository.findByIdForOrg(first, ORG_B)).toBeNull();
    expect(await orgDomainClaimRepository.updatePolicy(first, ORG_B, { policy: 'off' })).toBeNull();
    expect(await orgDomainClaimRepository.deleteForOrg(first, ORG_B)).toBe(false);
    const verified = await orgDomainClaimRepository.markVerified(first, { organizationId: ORG_A });
    expect(verified).toMatchObject({ organizationId: ORG_A, status: 'verified' });
    if (!verified || verified === 'conflict') throw new Error('Expected a verified claim');
    expect(await orgDomainClaimRepository.markVerified(first, { organizationId: ORG_A.toUpperCase() })).toMatchObject({
      organizationId: ORG_A,
      verifiedAt: verified.verifiedAt,
    });
    await orgDomainClaimRepository.updatePolicy(first, ORG_A, { policy: 'auto-join' });
    expect(await orgDomainClaimRepository.findVerifiedByDomain('legacy-first.example')).toMatchObject({
      organizationId: ORG_A,
    });
    expect(await orgDomainClaimRepository.findVerifiedJoinableByDomain('legacy-first.example')).toMatchObject({
      organizationId: ORG_A,
    });
    expect((await OrgDomainClaim.collection.findOne({ _id: new mongoose.Types.ObjectId(first) }))?.organizationId).toBe(
      ORG_A.toUpperCase()
    );
    expect(await orgDomainClaimRepository.deleteForOrg(first, ORG_A.toUpperCase())).toBe(true);
    expect(await orgDomainClaimRepository.deleteByOrganization(ORG_A)).toBe(1);
    expect(await OrgDomainClaim.findById(second)).toBeNull();
    expect(await OrgDomainClaim.findById(other.id)).not.toBeNull();
  });

  it('rejects malformed organization filters before any query can broaden the scope', async () => {
    await expect(orgDomainClaimRepository.listByOrganization('.*')).rejects.toThrow();
    await expect(orgDomainClaimRepository.deleteByOrganization('.*')).rejects.toThrow();
    await expect(createClaim('.*')).rejects.toThrow();
    expect(await OrgDomainClaim.countDocuments({})).toBe(0);
  });
});

describe('Space-owned claims', () => {
  setupMongoTest();
  const SPACE_A = 'c'.repeat(24);
  const SPACE_B = 'd'.repeat(24);

  const createSpaceClaim = (spaceId: string, domain = 'acme.com') =>
    orgDomainClaimRepository.create({
      spaceId,
      domain,
      status: 'pending',
      verificationToken: `token-${spaceId}`,
      verifiedAt: null,
      policy: 'off',
      createdBy: null,
    });

  beforeEach(async () => {
    await OrgDomainClaim.deleteMany({});
    await OrgDomainClaim.syncIndexes();
  });

  it('serializes a Space claim without an organization id', async () => {
    const claim = await createSpaceClaim(SPACE_A);
    const json = (await OrgDomainClaim.findById(claim.id))!.toJSON();
    expect(json).toMatchObject({ spaceId: SPACE_A, domain: 'acme.com', status: 'pending' });
    expect(json.organizationId).toBeUndefined();
    expect((await orgDomainClaimRepository.listBySpace(SPACE_A))[0]).toMatchObject({ spaceId: SPACE_A });
  });

  it('serializes an org claim without a space id', async () => {
    const claim = await createClaim(ORG_A);
    const json = (await OrgDomainClaim.findById(claim.id))!.toJSON();
    expect(json.organizationId).toBe(ORG_A);
    expect(json.spaceId).toBeUndefined();
  });

  it('rejects a claim with both owners and a claim with neither', async () => {
    const base = { domain: 'acme.com', status: 'pending', verificationToken: 't', policy: 'off' } as const;
    await expect(OrgDomainClaim.create({ ...base, organizationId: ORG_A, spaceId: SPACE_A })).rejects.toThrow(
      /exactly one of organizationId or spaceId/
    );
    await expect(OrgDomainClaim.create({ ...base })).rejects.toThrow(/exactly one of organizationId or spaceId/);
    await expect(OrgDomainClaim.create({ ...base, spaceId: 'not-an-id' })).rejects.toThrow();
  });

  it('keeps one claim per Space and domain, but lets Spaces share a pending domain', async () => {
    await createSpaceClaim(SPACE_A);
    await expect(createSpaceClaim(SPACE_B)).resolves.toBeTruthy();
    await expect(createSpaceClaim(SPACE_A, 'ACME.com')).rejects.toMatchObject({ code: 11000 });
  });

  it('allows one verified holder per domain across orgs and Spaces', async () => {
    const space = await createSpaceClaim(SPACE_A);
    const org = await createClaim(ORG_A);
    expect(await orgDomainClaimRepository.markVerified(String(space.id), { spaceId: SPACE_A })).toMatchObject({
      status: 'verified',
    });
    expect(await orgDomainClaimRepository.markVerified(String(org.id), { organizationId: ORG_A })).toBe('conflict');
  });

  it('scopes id lookups and mutations to the owning Space', async () => {
    const claim = await createSpaceClaim(SPACE_A);
    const id = String(claim.id);
    expect(await orgDomainClaimRepository.findByIdForSpace(id, SPACE_B)).toBeNull();
    expect(await orgDomainClaimRepository.findByIdForOrg(id, ORG_A)).toBeNull();
    expect(await orgDomainClaimRepository.markVerified(id, { spaceId: SPACE_B })).toBeNull();
    expect(await orgDomainClaimRepository.updatePolicyForSpace(id, SPACE_B, { policy: 'suggest' })).toBeNull();
    expect(await orgDomainClaimRepository.deleteForSpace(id, SPACE_B)).toBe(false);
    expect(await orgDomainClaimRepository.countBySpace(SPACE_A)).toBe(1);
    expect(await orgDomainClaimRepository.updatePolicyForSpace(id, SPACE_A, { policy: 'suggest' })).toMatchObject({
      policy: 'suggest',
    });
    expect(await orgDomainClaimRepository.deleteForSpace(id, SPACE_A)).toBe(true);
  });

  it('never returns a Space claim as an org-joinable claim', async () => {
    const claim = await createSpaceClaim(SPACE_A);
    await orgDomainClaimRepository.markVerified(String(claim.id), { spaceId: SPACE_A });
    await orgDomainClaimRepository.updatePolicyForSpace(String(claim.id), SPACE_A, { policy: 'suggest' });

    expect(await orgDomainClaimRepository.findVerifiedJoinableByDomain('acme.com')).toBeNull();
    expect(await orgDomainClaimRepository.findVerifiedByDomain('acme.com')).toMatchObject({ spaceId: SPACE_A });
    expect(await orgDomainClaimRepository.findVerifiedSpaceClaimByDomain('acme.com')).toMatchObject({
      spaceId: SPACE_A,
    });
  });

  it('offers only a verified Space claim whose policy is suggest', async () => {
    const claim = await createSpaceClaim(SPACE_A);
    const id = String(claim.id);
    expect(await orgDomainClaimRepository.findVerifiedSpaceClaimByDomain('acme.com')).toBeNull();
    await orgDomainClaimRepository.markVerified(id, { spaceId: SPACE_A });
    expect(await orgDomainClaimRepository.findVerifiedSpaceClaimByDomain('acme.com')).toBeNull();
    await orgDomainClaimRepository.updatePolicyForSpace(id, SPACE_A, { policy: 'suggest' });
    expect(await orgDomainClaimRepository.findVerifiedSpaceClaimByDomain('acme.com')).not.toBeNull();
  });

  it('releases only the verified Space claims on a domain and returns them', async () => {
    const verified = await createSpaceClaim(SPACE_A);
    await orgDomainClaimRepository.markVerified(String(verified.id), { spaceId: SPACE_A });
    await createSpaceClaim(SPACE_B);
    await createSpaceClaim(SPACE_A, 'other.com');
    await createClaim(ORG_A);

    const released = await orgDomainClaimRepository.deleteSpaceClaimsByDomain('ACME.com');

    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ spaceId: SPACE_A, domain: 'acme.com', status: 'verified' });
    expect(await OrgDomainClaim.countDocuments({})).toBe(3);
    expect(await orgDomainClaimRepository.deleteSpaceClaimsByDomain('acme.com')).toEqual([]);
  });

  it('deletes every claim of a Space', async () => {
    await createSpaceClaim(SPACE_A, 'acme.com');
    await createSpaceClaim(SPACE_A, 'acme.org');
    await createSpaceClaim(SPACE_B, 'acme.com');
    await createClaim(ORG_A, 'acme.com');

    expect(await orgDomainClaimRepository.deleteBySpace(SPACE_A)).toBe(2);
    expect(await OrgDomainClaim.countDocuments({})).toBe(2);
  });
});
