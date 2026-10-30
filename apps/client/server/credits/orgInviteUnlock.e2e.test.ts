import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InviteType } from '@bike4mind/common';
import {
  AdminSettings,
  CreditTransaction,
  Invite,
  mongoose,
  Organization,
  User,
  userRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { unlockSignupGrantFromAcceptedOrgInvite, unlockSignupGrantFromOrgInvite } from './orgInviteUnlock';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  for (const model of [User, CreditTransaction, Invite, Organization, AdminSettings]) {
    await model.createCollection();
  }
  await CreditTransaction.collection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
  await User.collection.createIndex(
    { freeCreditClaimEmail: 1 },
    { unique: true, partialFilterExpression: { freeCreditClaimEmail: { $type: 'string' } } }
  );
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  for (const model of [User, CreditTransaction, Invite, Organization, AdminSettings]) {
    await model.collection.deleteMany({});
  }
  await AdminSettings.create({ settingName: 'signupGrantOrgInviteEnabled', settingValue: 'true' });
});

async function createUser(name: string) {
  return User.create({
    name,
    username: name,
    email: `${name}@example.test`,
    emailVerified: true,
    currentCredits: 12,
    signupGrant: {
      stage: 'signup',
      signupCredits: 12,
      unlockCredits: 28,
      creditsReleased: 12,
      nextCondition: 'verification',
    },
  });
}

async function inviteUsers(users: Array<{ id: string; email: string | null }>, seats = 3) {
  const organization = await Organization.create({
    name: 'Grant organization',
    userId: 'synthetic-owner',
    seats,
    users: users.map(user => ({ userId: user.id, permissions: ['read'] })),
  });
  const invite = await Invite.create({
    type: InviteType.Organization,
    documentId: organization.id,
    remaining: 0,
    recipients: { accepted: users.map(user => user.email), pending: [], refused: [] },
  });
  return { organization, invite };
}

async function budget(organizationId: string): Promise<unknown> {
  return (await Organization.collection.findOne({ _id: new mongoose.Types.ObjectId(organizationId) }))
    ?.signupGrantUnlockCount;
}

describe('organization signup grant lifetime budget', () => {
  it('serializes different users racing for the final slot and initializes from existing grants', async () => {
    const first = await createUser('race-first');
    const second = await createUser('race-second');
    const { organization, invite } = await inviteUsers([first, second], 3);
    await User.collection.insertMany(
      ['previous-1', 'previous-2'].map(name => ({
        name,
        signupGrant: { unlockedOrgId: organization.id },
      }))
    );
    // Make both transactions observe the same final slot before either reserves it.
    // A read-count-only implementation would then pay both accounts deterministically.
    const barrier = { readers: 0, release: () => {} };
    const bothRead = new Promise<void>(resolve => {
      barrier.release = resolve;
    });
    const count = userRepository.count.bind(userRepository);
    vi.spyOn(userRepository, 'count').mockImplementation(async filter => {
      const result = await count(filter);
      barrier.readers += 1;
      if (barrier.readers === 2) barrier.release();
      await bothRead;
      return result;
    });
    const releases = await Promise.all([
      unlockSignupGrantFromOrgInvite(first.id, invite.id),
      unlockSignupGrantFromOrgInvite(second.id, invite.id),
    ]);
    expect(releases.map(result => result.creditsGranted).sort()).toEqual([0, 28]);
    expect(await budget(organization.id)).toBe(3);
    expect(await CreditTransaction.countDocuments({})).toBe(1);
  });

  it('does not replenish the lifetime budget when a recipient leaves and deletes their account', async () => {
    const first = await createUser('deleted-first');
    const second = await createUser('deleted-second');
    const { organization, invite } = await inviteUsers([first], 2);
    await User.collection.insertOne({ signupGrant: { unlockedOrgId: organization.id } });
    expect((await unlockSignupGrantFromOrgInvite(first.id, invite.id)).creditsGranted).toBe(28);
    await User.collection.deleteOne({ _id: first._id });
    await Organization.updateOne({ _id: organization.id }, { $pull: { users: { userId: first.id } } });
    await Organization.updateOne(
      { _id: organization.id },
      { $push: { users: { userId: second.id, permissions: ['read'] } } }
    );
    await Invite.updateOne({ _id: invite.id }, { $push: { 'recipients.accepted': second.email } });
    expect((await unlockSignupGrantFromOrgInvite(second.id, invite.id)).creditsGranted).toBe(0);
    expect(await budget(organization.id)).toBe(2);
  });

  it('rolls back a failed payout reservation and consumes no extra slot on replay', async () => {
    const user = await createUser('rollback');
    const { organization, invite } = await inviteUsers([user], 2);
    const update = vi.spyOn(userRepository, 'update').mockRejectedValueOnce(new Error('payout failed'));
    await expect(unlockSignupGrantFromOrgInvite(user.id, invite.id)).rejects.toThrow('payout failed');
    expect(await budget(organization.id)).toBeUndefined();
    expect(await CreditTransaction.countDocuments({})).toBe(0);
    update.mockRestore();
    expect((await unlockSignupGrantFromOrgInvite(user.id, invite.id)).creditsGranted).toBe(28);
    expect((await unlockSignupGrantFromOrgInvite(user.id, invite.id)).creditsGranted).toBe(0);
    expect(await budget(organization.id)).toBe(1);
  });

  it('retries another accepted organization when the first one has exhausted its budget', async () => {
    const user = await createUser('multiple-orgs');
    const exhausted = await inviteUsers([user], 2);
    await Organization.collection.updateOne(
      { _id: exhausted.organization._id },
      { $set: { signupGrantUnlockCount: 2 } }
    );
    const available = await inviteUsers([user], 2);
    expect((await unlockSignupGrantFromAcceptedOrgInvite(user.id)).creditsGranted).toBe(28);
    expect((await User.findById(user.id))?.signupGrant?.unlockedOrgId).toBe(available.organization.id);
    expect(await budget(exhausted.organization.id)).toBe(2);
    expect(await budget(available.organization.id)).toBe(1);
  });
});
