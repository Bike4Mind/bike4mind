/**
 * Real-Mongo coverage for Space domain claims: the release transaction, the one-verified-holder index
 * and the member pulls live in Mongo, so a mock cannot show them. Integration lane only.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  Inbox,
  Organization,
  OrgDomainClaim,
  Space,
  User,
  inviteRepository,
  orgDomainClaimRepository,
  spaceRepository,
  withTransaction,
} from '@bike4mind/database';
import { ISpaceDocument, IUserDocument } from '@bike4mind/common';
import { joinViaDomain } from '../../../../b4m-core/services/src/spaceService/joinViaDomain';
import { recheckDomainMembers } from '../../../../b4m-core/services/src/spaceService/recheckDomainMembers';
import { remove } from '../../../../b4m-core/services/src/spaceService/remove';
import {
  addDomainClaim,
  addSpaceDomainClaim,
  applyOrgDomainMembership,
  isDomainJoinable,
  joinableSpaceIdsForEmail,
  listOrgDomainJoinSuggestions,
  recordValueFor,
  updateSpaceDomainClaimPolicy,
  verifyDomainClaim,
  verifySpaceDomainClaim,
} from '../organizations/orgDomainClaims';

vi.mock('@server/utils/spaceDomainNotifier', () => ({ notifySpaceDomainReleasedByEmail: vi.fn() }));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  mongoServer = await createMongoReplSet();
  await mongoose.connect(mongoServer.getUri());
  await settleAutoIndexBuilds(mongoose);
  await OrgDomainClaim.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await Promise.all([
    Organization.deleteMany({}, { hardDelete: true }),
    User.deleteMany({}, { hardDelete: true }),
    OrgDomainClaim.deleteMany({}),
    Space.deleteMany({}),
    Inbox.deleteMany({}),
  ]);
});

const DOMAIN = 'example.com';

const makeUser = (email: string, emailVerified = true) =>
  User.create({ username: email.replace(/\W/g, ''), name: 'Dee', email, emailVerified });

const makeOrg = (ownerId: string) => Organization.create({ name: 'Example Org', userId: ownerId, seats: 10 });

const makeSpace = (ownerUserId: string, over: Record<string, unknown> = {}) =>
  Space.create({ name: 'Team', ownerUserId, members: [], removedUserIds: [], ...over });

const asDoc = async (userId: string) => (await User.findById(userId))!.toJSON() as unknown as IUserDocument;

const resolverFor = (token: string) => async () => [[recordValueFor(token)]];

const verifiedSpaceClaim = async (spaceId: string, policy: 'off' | 'suggest' = 'suggest') => {
  const claim = await addSpaceDomainClaim(spaceId, 'owner', DOMAIN);
  await verifySpaceDomainClaim(spaceId, claim.id, resolverFor(claim.verificationToken));
  await updateSpaceDomainClaimPolicy(spaceId, claim.id, { policy });
  return claim;
};

const verifiedOrgClaim = async (orgId: string, policy: 'suggest' | 'auto-join' | 'off' = 'suggest') => {
  const claim = await addDomainClaim(orgId, 'owner', DOMAIN);
  await verifyDomainClaim(orgId, claim.id, resolverFor(claim.verificationToken));
  await OrgDomainClaim.updateOne({ _id: claim.id }, { policy });
  return claim;
};

const join = async (userId: string, spaceId: string, cap = 1000) =>
  withTransaction(async () =>
    joinViaDomain(
      await asDoc(userId),
      { spaceId },
      { db: { spaces: spaceRepository }, limits: { spaceMaxMembers: cap }, isDomainJoinable }
    )
  );

const membersOf = async (spaceId: string) => (await Space.findById(spaceId).lean())!.members.map(m => m.userId);

describe('org verify releases Space claims (real transaction)', () => {
  it('deletes the verified Space claim, keeps domain-joined members and notifies the owner', async () => {
    const spaceOwner = await makeUser('so@other.org');
    const space = await makeSpace(spaceOwner.id);
    await verifiedSpaceClaim(space.id);
    const dee = await makeUser(`dee@${DOMAIN}`);
    await join(dee.id, space.id);

    const orgOwner = await makeUser('oo@other.org');
    const org = await makeOrg(orgOwner.id);
    await verifiedOrgClaim(org.id);

    expect(await OrgDomainClaim.countDocuments({ spaceId: space.id })).toBe(0);
    expect(await OrgDomainClaim.countDocuments({ organizationId: org.id, status: 'verified' })).toBe(1);
    expect(await membersOf(space.id)).toEqual([dee.id]);
    const notices = await Inbox.find({ receiverId: spaceOwner.id }).lean();
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0])).toContain(DOMAIN);
    expect(JSON.stringify(notices[0])).not.toContain(org.id);
    expect(await isDomainJoinable((await Space.findById(space.id))! as unknown as ISpaceDocument, `x@${DOMAIN}`)).toBe(
      false
    );
  });

  it('does not release when the org only adds the claim', async () => {
    const spaceOwner = await makeUser('so@other.org');
    const space = await makeSpace(spaceOwner.id);
    await verifiedSpaceClaim(space.id);
    const org = await makeOrg((await makeUser('oo@other.org')).id);
    await addDomainClaim(org.id, 'owner', DOMAIN);
    expect(await OrgDomainClaim.countDocuments({ spaceId: space.id, status: 'verified' })).toBe(1);
  });

  it('refuses a Space add or verify while an org holds the domain', async () => {
    const org = await makeOrg((await makeUser('oo@other.org')).id);
    await verifiedOrgClaim(org.id);
    const space = await makeSpace((await makeUser('so@other.org')).id);
    await expect(addSpaceDomainClaim(space.id, 'owner', DOMAIN)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('keeps one verified holder per domain across Spaces', async () => {
    const owner = await makeUser('so@other.org');
    const first = await makeSpace(owner.id);
    const second = await makeSpace(owner.id);
    await verifiedSpaceClaim(first.id);
    await expect(addSpaceDomainClaim(second.id, 'owner', DOMAIN)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('org flows ignore Space claims', () => {
  it('does not auto-join or suggest an org for an address a Space claims', async () => {
    const space = await makeSpace((await makeUser('so@other.org')).id);
    await verifiedSpaceClaim(space.id);
    const dee = await makeUser(`dee@${DOMAIN}`);
    expect(await applyOrgDomainMembership(dee.id, `dee@${DOMAIN}`)).toMatchObject({ joined: false });
    expect(await listOrgDomainJoinSuggestions(dee.id)).toEqual([]);
  });
});

describe('Space delete frees the domain', () => {
  it('lets another Space claim it afterwards', async () => {
    const owner = await makeUser('so@other.org');
    const first = await makeSpace(owner.id);
    const second = await makeSpace(owner.id);
    await verifiedSpaceClaim(first.id);

    await withTransaction(() =>
      remove(
        { id: owner.id } as IUserDocument,
        { spaceId: first.id },
        { db: { spaces: spaceRepository, invites: inviteRepository, orgDomainClaims: orgDomainClaimRepository } }
      )
    );

    expect(await OrgDomainClaim.countDocuments({ spaceId: first.id })).toBe(0);
    await expect(addSpaceDomainClaim(second.id, 'owner', DOMAIN)).resolves.toBeTruthy();
  });
});

describe('domain join rules', () => {
  it('joins by the Space own suggest claim, exact domain only', async () => {
    const space = await makeSpace((await makeUser('so@other.org')).id);
    await verifiedSpaceClaim(space.id);
    const dee = await makeUser(`dee@${DOMAIN}`);
    const sub = await makeUser(`sub@mail.${DOMAIN}`);

    await join(dee.id, space.id);
    await expect(join(sub.id, space.id)).rejects.toMatchObject({ statusCode: 403 });
    const row = (await Space.findById(space.id).lean())!.members[0];
    expect(row).toMatchObject({ userId: dee.id, role: 'member', joinedVia: 'domain' });
  });

  it('refuses a Space whose claim policy is off', async () => {
    const space = await makeSpace((await makeUser('so@other.org')).id);
    await verifiedSpaceClaim(space.id, 'off');
    const dee = await makeUser(`dee@${DOMAIN}`);
    await expect(join(dee.id, space.id)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses an unverified email', async () => {
    const space = await makeSpace((await makeUser('so@other.org')).id);
    await verifiedSpaceClaim(space.id);
    const dee = await makeUser(`dee@${DOMAIN}`, false);
    await expect(join(dee.id, space.id)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('inherits the parent org claim while the owner administers it, and stops when the owner leaves', async () => {
    const owner = await makeUser('so@other.org');
    const org = await makeOrg(owner.id);
    await verifiedOrgClaim(org.id, 'suggest');
    const space = await makeSpace(owner.id, { parentOrganizationId: org.id });
    const dee = await makeUser(`dee@${DOMAIN}`);

    expect(await joinableSpaceIdsForEmail(`dee@${DOMAIN}`)).toEqual([space.id]);
    await join(dee.id, space.id);
    expect(await membersOf(space.id)).toEqual([dee.id]);

    const other = await makeUser(`other@${DOMAIN}`);
    await Space.updateOne({ _id: space.id }, { ownerUserId: 'someone-who-left' });
    expect(await joinableSpaceIdsForEmail(`other@${DOMAIN}`)).toEqual([]);
    await expect(join(other.id, space.id)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses inheritance when the parent claim policy is off', async () => {
    const owner = await makeUser('so@other.org');
    const org = await makeOrg(owner.id);
    await verifiedOrgClaim(org.id, 'off');
    const space = await makeSpace(owner.id, { parentOrganizationId: org.id });
    const dee = await makeUser(`dee@${DOMAIN}`);
    await expect(join(dee.id, space.id)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses a removed user and lets a voluntary leaver rejoin', async () => {
    const space = await makeSpace((await makeUser('so@other.org')).id);
    await verifiedSpaceClaim(space.id);
    const removed = await makeUser(`removed@${DOMAIN}`);
    const leaver = await makeUser(`leaver@${DOMAIN}`);
    await Space.updateOne({ _id: space.id }, { removedUserIds: [removed.id] });

    await expect(join(removed.id, space.id)).rejects.toMatchObject({ statusCode: 403 });

    await join(leaver.id, space.id);
    await spaceRepository.removeMember(space.id, leaver.id, { block: false });
    await join(leaver.id, space.id);
    expect(await membersOf(space.id)).toEqual([leaver.id]);
  });

  it('enforces the member cap and answers 409 to an existing member', async () => {
    const space = await makeSpace((await makeUser('so@other.org')).id);
    await verifiedSpaceClaim(space.id);
    const first = await makeUser(`first@${DOMAIN}`);
    const second = await makeUser(`second@${DOMAIN}`);
    await join(first.id, space.id, 1);
    await expect(join(second.id, space.id, 1)).rejects.toMatchObject({
      statusCode: 403,
      message: 'This space is full',
    });
    await expect(join(first.id, space.id, 1)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('email change recheck', () => {
  const recheck = (userId: string, email: string) =>
    recheckDomainMembers(userId, email, { db: { spaces: spaceRepository }, isDomainJoinable });

  it('removes a domain member whose new address is not joinable, without blocking a rejoin', async () => {
    const space = await makeSpace((await makeUser('so@other.org')).id);
    await verifiedSpaceClaim(space.id);
    const dee = await makeUser(`dee@${DOMAIN}`);
    await join(dee.id, space.id);

    await recheck(dee.id, 'dee@elsewhere.org');

    const after = (await Space.findById(space.id).lean())!;
    expect(after.members).toHaveLength(0);
    expect(after.removedUserIds).not.toContain(dee.id);
  });

  it('keeps the member on a move between joinable domains', async () => {
    const owner = await makeUser('so@other.org');
    const org = await makeOrg(owner.id);
    await verifiedOrgClaim(org.id, 'suggest');
    const space = await makeSpace(owner.id, { parentOrganizationId: org.id });
    const dee = await makeUser(`dee@${DOMAIN}`);
    await join(dee.id, space.id);

    await recheck(dee.id, `dee2@${DOMAIN}`);
    expect(await membersOf(space.id)).toEqual([dee.id]);
  });

  it('leaves invite and link members untouched', async () => {
    const space = await makeSpace((await makeUser('so@other.org')).id);
    const dee = await makeUser(`dee@${DOMAIN}`);
    await Space.updateOne(
      { _id: space.id },
      {
        $push: {
          members: [
            { userId: dee.id, role: 'member', joinedVia: 'invite', joinedAt: new Date() },
            { userId: 'link-user', role: 'member', joinedVia: 'link', joinedAt: new Date() },
          ],
        },
      }
    );
    await recheck(dee.id, 'dee@elsewhere.org');
    await recheck('link-user', 'x@elsewhere.org');
    expect(await membersOf(space.id)).toEqual([dee.id, 'link-user']);
  });

  it('rolls the removal back with the surrounding transaction', async () => {
    const space = await makeSpace((await makeUser('so@other.org')).id);
    await verifiedSpaceClaim(space.id);
    const dee = await makeUser(`dee@${DOMAIN}`);
    await join(dee.id, space.id);

    await expect(
      withTransaction(async () => {
        await recheck(dee.id, 'dee@elsewhere.org');
        throw new Error('email change failed');
      })
    ).rejects.toThrow('email change failed');

    expect(await membersOf(space.id)).toEqual([dee.id]);
  });
});
