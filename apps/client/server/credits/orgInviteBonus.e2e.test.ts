import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InviteType } from '@bike4mind/common';
import { Invite, mongoose, User } from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { recordOrgSignupInvite } from './orgInviteBonus';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all([User.createCollection(), Invite.createCollection()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

beforeEach(async () => {
  await Promise.all([User.collection.deleteMany({}), Invite.collection.deleteMany({})]);
});

const organizationId = new mongoose.Types.ObjectId().toHexString();
const grant = { stage: 'signup', signupCredits: 10, unlockCredits: 20, creditsReleased: 10 };

async function createInvite(type = InviteType.Organization) {
  return Invite.create({
    type,
    documentId: organizationId,
    remaining: 0,
    recipients: { accepted: ['new@example.test'], pending: [], refused: [] },
  });
}

async function createUser(name: string, extra: Record<string, unknown> = {}) {
  return User.create({ name, username: name, email: `${name}@example.test`, signupGrant: grant, ...extra });
}

describe('recordOrgSignupInvite', () => {
  it('marks an account created after the invite once, even when replayed concurrently', async () => {
    const invite = await createInvite();
    const user = await createUser('new');
    const results = await Promise.all([
      recordOrgSignupInvite(user.id, invite.id),
      recordOrgSignupInvite(user.id, invite.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await User.findById(user.id).lean();
    expect(stored?.signupInvite).toEqual({
      source: 'organization',
      inviteId: invite.id,
      organizationId,
      at: expect.any(Date),
    });
  });

  it('does not mark an account that existed before the invite', async () => {
    const user = await createUser('old');
    await User.collection.updateOne({ _id: user._id }, { $set: { createdAt: new Date(0) } });
    const invite = await createInvite();
    expect(await recordOrgSignupInvite(user.id, invite.id)).toBe(false);
    expect((await User.findById(user.id).lean())?.signupInvite).toBeUndefined();
  });

  it('does not mark an account without a signup grant', async () => {
    const invite = await createInvite();
    const user = await createUser('sso', { signupGrant: undefined });
    expect(await recordOrgSignupInvite(user.id, invite.id)).toBe(false);
  });

  it('does not mark through a non-organization invite or overwrite an existing mark', async () => {
    const projectInvite = await createInvite(InviteType.Project);
    const user = await createUser('new');
    expect(await recordOrgSignupInvite(user.id, projectInvite.id)).toBe(false);

    const orgInvite = await createInvite();
    await User.collection.updateOne(
      { _id: user._id },
      { $set: { signupInvite: { source: 'referral', inviteId: 'earlier', at: new Date() } } }
    );
    expect(await recordOrgSignupInvite(user.id, orgInvite.id)).toBe(false);
    expect((await User.findById(user.id).lean())?.signupInvite?.source).toBe('referral');
  });
});
