/**
 * Real-Mongo coverage for org-domain auto-join and suggest-join: the seat guard and the users[]/userDetails[] writes
 * live in Mongo update pipelines, so a mock cannot show them. Integration lane only.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Organization, OrgDomainClaim, PartnerSignupRule, User } from '@bike4mind/database';
import { applyOrgDomainMembership, joinOrgViaDomain, listOrgDomainJoinSuggestions } from './orgDomainClaims';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
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
    PartnerSignupRule.deleteMany({}),
  ]);
});

const makeUser = async (email: string, emailVerified = true) =>
  User.create({ username: email.split('@')[0], name: 'Dee', email, emailVerified });

const makeOrg = async (seats = 10) => Organization.create({ name: 'Example Org', userId: 'owner-1', seats });

const makeClaim = async (
  organizationId: string,
  overrides: Partial<{ domain: string; status: string; policy: string }> = {}
) =>
  OrgDomainClaim.create({
    organizationId,
    domain: 'example.com',
    status: 'verified',
    verificationToken: 'a'.repeat(32),
    verifiedAt: new Date(),
    policy: 'auto-join',
    ...overrides,
  });

const reload = async (orgId: string) => (await Organization.findById(orgId).lean())!;

// A join that wrote the users[] row, then failed before the org pointer and the userDetails row.
const makeHalfJoined = async (policy: string) => {
  const org = await makeOrg(5);
  await makeClaim(org.id, { policy });
  const user = await makeUser('dee@example.com');
  await Organization.updateOne({ _id: org._id }, { $push: { users: { userId: user.id, permissions: ['read'] } } });
  return { org, user };
};

const expectRepaired = async (orgId: string, userId: string) => {
  const after = await reload(orgId);
  expect(after.users).toHaveLength(1);
  expect(after.userDetails?.map(d => d.id)).toEqual([userId]);
  expect(String((await User.findById(userId).lean())!.organizationId)).toBe(orgId);
};

describe('applyOrgDomainMembership (real Mongo)', () => {
  it('adds a verified user as a read-only member, seeds userDetails, sets the org pointer, leaves seats alone', async () => {
    const org = await makeOrg(5);
    await makeClaim(org.id);
    const user = await makeUser('dee@EXAMPLE.com');

    const outcome = await applyOrgDomainMembership(user.id, 'dee@EXAMPLE.com');

    expect(outcome).toEqual({ joined: true, organizationId: org.id });
    const after = await reload(org.id);
    expect(after.users).toEqual([expect.objectContaining({ userId: user.id, permissions: ['read'] })]);
    expect(after.userDetails?.map(d => d.id)).toEqual([user.id]);
    expect(after.seats).toBe(5);
    expect(String((await User.findById(user.id).lean())!.organizationId)).toBe(org.id);
  });

  it('is idempotent on a re-run', async () => {
    const org = await makeOrg();
    await makeClaim(org.id);
    const user = await makeUser('dee@example.com');

    await applyOrgDomainMembership(user.id, 'dee@example.com');
    const second = await applyOrgDomainMembership(user.id, 'dee@example.com');

    expect(second).toEqual({ joined: false, reason: 'already-member' });
    expect((await reload(org.id)).users).toHaveLength(1);
  });

  it('completes a half-finished join on retry: sets the org pointer and seeds userDetails', async () => {
    const { org, user } = await makeHalfJoined('auto-join');

    expect(await applyOrgDomainMembership(user.id, 'dee@example.com')).toEqual({
      joined: false,
      reason: 'already-member',
    });
    await expectRepaired(org.id, user.id);
  });

  it('never adds a users[] row for the owner', async () => {
    const owner = await makeUser('owner@example.com');
    const org = await Organization.create({ name: 'Example Org', userId: owner.id, seats: 5 });
    await makeClaim(org.id);

    expect(await applyOrgDomainMembership(owner.id, 'owner@example.com')).toEqual({
      joined: false,
      reason: 'already-member',
    });
    expect((await reload(org.id)).users).toEqual([]);
  });

  it('does not join, or raise seats, when the org is full', async () => {
    const org = await makeOrg(1);
    await makeClaim(org.id);
    const user = await makeUser('dee@example.com');

    const outcome = await applyOrgDomainMembership(user.id, 'dee@example.com');

    expect(outcome).toMatchObject({ joined: false, reason: 'at-capacity', organizationId: org.id, seats: 1 });
    const after = await reload(org.id);
    expect(after.users).toEqual([]);
    expect(after.seats).toBe(1);
  });

  it.each([
    ['an unverified email', { verified: false, email: 'dee@example.com', claim: {} }, 'unverified'],
    [
      'a suggest-only claim',
      { verified: true, email: 'dee@example.com', claim: { policy: 'suggest' } },
      'not-auto-join',
    ],
    ['a pending claim', { verified: true, email: 'dee@example.com', claim: { status: 'pending' } }, 'no-claim'],
    ['a policy-off claim', { verified: true, email: 'dee@example.com', claim: { policy: 'off' } }, 'no-claim'],
    ['a subdomain email', { verified: true, email: 'dee@eng.example.com', claim: {} }, 'no-claim'],
  ])('does not join for %s', async (_label, { verified, email, claim }, reason) => {
    const org = await makeOrg();
    await makeClaim(org.id, claim);
    const user = await makeUser(email, verified);

    expect(await applyOrgDomainMembership(user.id, email)).toEqual({ joined: false, reason });
    expect((await reload(org.id)).users).toEqual([]);
  });
});

describe('suggest-join for an existing user (real Mongo)', () => {
  it('suggests, then joins as a read-only member, and stops suggesting once a member', async () => {
    const org = await makeOrg(5);
    const claim = await makeClaim(org.id, { policy: 'suggest' });
    const user = await makeUser('dee@example.com');

    expect(await listOrgDomainJoinSuggestions(user.id)).toEqual([
      { organizationId: org.id, organizationName: 'Example Org', claimId: claim.id },
    ]);

    expect((await joinOrgViaDomain(user.id, org.id)).joined).toBe(true);
    const after = await reload(org.id);
    expect(after.users).toEqual([expect.objectContaining({ userId: user.id, permissions: ['read'] })]);
    expect(after.seats).toBe(5);
    expect(String((await User.findById(user.id).lean())!.organizationId)).toBe(org.id);

    expect((await joinOrgViaDomain(user.id, org.id)).joined).toBe(false);
    expect((await reload(org.id)).users).toHaveLength(1);
    expect(await listOrgDomainJoinSuggestions(user.id)).toEqual([]);
  });

  it('completes a half-finished join when the user asks to join again', async () => {
    const { org, user } = await makeHalfJoined('suggest');

    expect((await joinOrgViaDomain(user.id, org.id)).joined).toBe(false);
    await expectRepaired(org.id, user.id);
  });

  it('never adds a users[] row for the owner', async () => {
    const owner = await makeUser('owner@example.com');
    const org = await Organization.create({ name: 'Example Org', userId: owner.id, seats: 5 });
    await makeClaim(org.id, { policy: 'suggest' });

    expect(await listOrgDomainJoinSuggestions(owner.id)).toEqual([]);
    expect((await joinOrgViaDomain(owner.id, org.id)).joined).toBe(false);
    expect((await reload(org.id)).users).toEqual([]);
  });

  it('yields to an enabled partner rule for another org, but not to a disabled one', async () => {
    const org = await makeOrg(5);
    await makeClaim(org.id, { policy: 'suggest' });
    const user = await makeUser('dee@example.com');
    const rule = await PartnerSignupRule.create({ domain: 'example.com', organizationId: 'other-org', enabled: false });

    expect(await listOrgDomainJoinSuggestions(user.id)).toHaveLength(1);

    await PartnerSignupRule.updateOne({ _id: rule._id }, { $set: { enabled: true } });
    expect(await listOrgDomainJoinSuggestions(user.id)).toEqual([]);
    await expect(joinOrgViaDomain(user.id, org.id)).rejects.toThrow(/does not grant/);
    expect((await reload(org.id)).users).toEqual([]);
  });

  it('omits a full org and refuses the join without raising seats', async () => {
    const org = await makeOrg(1);
    await makeClaim(org.id, { policy: 'suggest' });
    const user = await makeUser('dee@example.com');

    expect(await listOrgDomainJoinSuggestions(user.id)).toEqual([]);
    await expect(joinOrgViaDomain(user.id, org.id)).rejects.toThrow('Organization is at full capacity');
    const after = await reload(org.id);
    expect(after.users).toEqual([]);
    expect(after.seats).toBe(1);
  });

  it.each([
    ['an unverified email', { verified: false, claim: {} }],
    ['a policy-off claim', { verified: true, claim: { policy: 'off' } }],
    ['a pending claim', { verified: true, claim: { status: 'pending' } }],
  ])('refuses %s', async (_label, { verified, claim }) => {
    const org = await makeOrg();
    await makeClaim(org.id, { policy: 'suggest', ...claim });
    const user = await makeUser('dee@example.com', verified);

    expect(await listOrgDomainJoinSuggestions(user.id)).toEqual([]);
    await expect(joinOrgViaDomain(user.id, org.id)).rejects.toThrow(/Verify your email|does not grant/);
    expect((await reload(org.id)).users).toEqual([]);
  });
});
