import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import {
  User,
  Project,
  CreditTransaction,
  AdminSettings,
  userRepository,
  PublishedArtifact,
  HeldCreditRewardModel,
} from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// The claim's money path against a real replica set: the ledger row and the balance are
// written in one transaction, so a failed balance write cannot leave the reward recorded as
// paid, and concurrent claims pay once. Only baseApi is mocked, to reach the handler.

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const mockRefs = vi.hoisted(() => ({ postHandler: null as null | Handler }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    post: (fn: Handler) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

let replSet: MongoMemoryReplSet;
let post: Handler;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await import('../claim');
  await settleAutoIndexBuilds(mongoose);
  post = mockRefs.postHandler!;
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

// The ledger's unique transactionId index is what stops a second payout, and
// dropDatabase removes it with the data - rebuild it for every test.
beforeEach(async () => {
  await CreditTransaction.createIndexes();
  // Gear rewards draw the trickle pool, and a missing pool setting pauses them.
  await AdminSettings.create({ settingName: 'signupGrantTricklePoolDaily', settingValue: '1000000000' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});

/** A user who owns a project, which unlocks the Projects gear (1000 credits).
 *  emailVerified and a past createdAt are set so the trust gate allows the payout. */
const seedUnlockedUser = async () => {
  const user = await User.create({
    name: 'Claimer',
    username: `claimer-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
    currentCredits: 0,
    emailVerified: true,
    createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
  });
  await Project.create({ name: 'First project', description: 'd', userId: user.id, users: [], fileIds: [] });
  return user;
};

const claim = async (userId: string, key = 'projects') => {
  const { req, res } = createMocks({ method: 'POST', body: { key } });
  (req as unknown as { user: { id: string } }).user = { id: userId };
  await post(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() };
};

const balanceOf = async (userId: string) => (await User.findById(userId).lean())?.currentCredits;
const ledgerRows = (userId: string) =>
  CreditTransaction.countDocuments({ transactionId: `gear-unlock:${userId}:projects` });

describe('POST /api/gears/claim on a real replica set', () => {
  it('pays once and records one ledger row', async () => {
    const user = await seedUnlockedUser();

    expect(await claim(user.id)).toEqual({ status: 200, body: { key: 'projects', creditsAwarded: 1000 } });
    expect(await balanceOf(user.id)).toBe(1000);
    expect(await ledgerRows(user.id)).toBe(1);

    // A second claim is a no-op on both the ledger and the balance.
    expect(await claim(user.id)).toEqual({ status: 200, body: { key: 'projects', alreadyClaimed: true } });
    expect(await balanceOf(user.id)).toBe(1000);
  });

  it('pays concurrent claims exactly once, and only one of them announces it', async () => {
    const user = await seedUnlockedUser();

    const results = await Promise.all([claim(user.id), claim(user.id), claim(user.id)]);

    expect(results.filter(r => r.body.creditsAwarded === 1000)).toHaveLength(1);
    // A loser that sees the winner's draw before its ledger row exists queues (202) instead;
    // the release cron then settles that row against the winner's ledger row without paying again.
    expect(results.filter(r => r.body.alreadyClaimed === true || r.body.queued === true)).toHaveLength(2);
    expect(await balanceOf(user.id)).toBe(1000);
    expect(await ledgerRows(user.id)).toBe(1);
  });

  it('rolls the ledger row back when the balance write fails, so a retry still pays', async () => {
    const user = await seedUnlockedUser();
    const increment = vi
      .spyOn(userRepository, 'incrementCredits')
      .mockRejectedValueOnce(new Error('balance write failed'));

    await expect(claim(user.id)).rejects.toThrow('balance write failed');
    expect(await ledgerRows(user.id)).toBe(0);
    expect(await balanceOf(user.id)).toBe(0);

    increment.mockRestore();
    expect(await claim(user.id)).toEqual({ status: 200, body: { key: 'projects', creditsAwarded: 1000 } });
    expect(await balanceOf(user.id)).toBe(1000);
    expect(await ledgerRows(user.id)).toBe(1);
  });
});

describe('social gear eligibility on a real replica set', () => {
  const member = (emailVerified = false) =>
    User.create({
      name: 'Collaborator',
      username: `member-${Math.random().toString(36).slice(2, 10)}`,
      emailVerified,
    });
  const page = (ownerId: string) =>
    PublishedArtifact.create({
      publicId: 'social-page',
      tier: 'user',
      scopeId: ownerId,
      slug: 'social-page',
      title: 'Shared work',
      ownerId,
      source: { kind: 'bundle' },
      externalViewCount: 10,
    });

  it('requires a distinct verified collaborator with read access, then pays once', async () => {
    const owner = await seedUnlockedUser();
    const friend = await member();
    const absentId = new mongoose.Types.ObjectId().toString();
    await Project.updateOne(
      { userId: owner.id },
      {
        $set: {
          users: [
            { userId: owner.id, permissions: ['read'] },
            { userId: friend.id, permissions: ['read'] },
            { userId: absentId, permissions: ['read'] },
          ],
        },
      }
    );
    expect(await claim(owner.id, 'shareproject')).toMatchObject({ status: 409, body: { error: 'reward_pending' } });
    expect(await balanceOf(owner.id)).toBe(0);
    await User.updateOne({ _id: friend.id }, { $set: { emailVerified: true } });
    expect(await claim(owner.id, 'shareproject')).toEqual({
      status: 200,
      body: { key: 'shareproject', creditsAwarded: 5000 },
    });
    await Project.updateOne({ userId: owner.id }, { $set: { users: [] } });
    expect(await claim(owner.id, 'shareproject')).toEqual({
      status: 200,
      body: { key: 'shareproject', alreadyClaimed: true },
    });
    expect(await balanceOf(owner.id)).toBe(5000);
  });

  it('does not count verified users without live project membership', async () => {
    const owner = await seedUnlockedUser();
    const friend = await member(true);
    expect(await claim(owner.id, 'shareproject')).toMatchObject({ status: 409 });
    await Project.updateOne(
      { userId: owner.id },
      {
        $set: {
          users: [{ userId: friend.id, permissions: ['read'] }],
          deletedAt: new Date(),
        },
      }
    );
    expect(await claim(owner.id, 'shareproject')).toMatchObject({ status: 409 });
    expect(await balanceOf(owner.id)).toBe(0);
  });

  it('requires a collaborator with read access', async () => {
    const owner = await seedUnlockedUser();
    const friend = await member(true);
    await Project.updateOne({ userId: owner.id }, { $set: { users: [{ userId: friend.id, permissions: [] }] } });
    expect(await claim(owner.id, 'shareproject')).toMatchObject({ status: 409 });
    expect(await balanceOf(owner.id)).toBe(0);
  });

  it('requires a live verified collaborator account', async () => {
    const owner = await seedUnlockedUser();
    const friend = await member(true);
    await Project.updateOne({ userId: owner.id }, { $set: { users: [{ userId: friend.id, permissions: ['read'] }] } });
    await User.deleteOne({ _id: friend.id });
    expect(await claim(owner.id, 'shareproject')).toMatchObject({ status: 409 });
    expect(await balanceOf(owner.id)).toBe(0);
  });

  it('requires verified view evidence on historical pages and pays concurrent claims once', async () => {
    const { recordVerifiedView } = await import('@server/services/publish/recordVerifiedView');
    const owner = await seedUnlockedUser();
    const friend = await member();
    const published = await page(owner.id);
    await PublishedArtifact.collection.updateOne({ _id: published._id }, { $unset: { verifiedExternalViewCount: '' } });
    const artifact = { publicId: published.publicId, ownerId: owner.id };
    for (const viewer of [undefined, owner.id, friend.id]) {
      await recordVerifiedView(artifact, viewer);
      expect(await claim(owner.id, 'published')).toMatchObject({ status: 409, body: { error: 'reward_pending' } });
    }
    await User.updateOne({ _id: friend.id }, { $set: { emailVerified: true } });
    await recordVerifiedView(artifact, friend.id);
    const results = await Promise.all([claim(owner.id, 'published'), claim(owner.id, 'published')]);
    expect(results.filter(r => r.body.creditsAwarded === 5000)).toHaveLength(1);
    expect(await balanceOf(owner.id)).toBe(5000);
    expect(await CreditTransaction.countDocuments({ transactionId: `gear-unlock:${owner.id}:published` })).toBe(1);
    await PublishedArtifact.deleteMany({});
    expect(await claim(owner.id, 'published')).toEqual({
      status: 200,
      body: { key: 'published', alreadyClaimed: true },
    });
  });

  it('records no Published reward evidence for a same-signup-IP or blocked verified viewer', async () => {
    const { recordVerifiedView } = await import('@server/services/publish/recordVerifiedView');
    const owner = await seedUnlockedUser();
    await User.updateOne({ _id: owner.id }, { $set: { 'signupMeta.ip': '203.0.113.1' } });
    const sameIp = await member(true);
    await User.updateOne({ _id: sameIp.id }, { $set: { 'signupMeta.ip': '203.0.113.1' } });
    const banned = await member(true);
    await User.updateOne({ _id: banned.id }, { $set: { isBanned: true } });
    const friend = await member(true);
    const published = await page(owner.id);
    const artifact = { publicId: published.publicId, ownerId: owner.id };
    for (const viewer of [sameIp.id, banned.id]) {
      await recordVerifiedView(artifact, viewer);
      expect(await claim(owner.id, 'published')).toMatchObject({ status: 409, body: { error: 'reward_pending' } });
    }
    expect((await PublishedArtifact.findById(published._id).lean())?.verifiedExternalViewCount ?? 0).toBe(0);
    await recordVerifiedView(artifact, friend.id);
    expect(await claim(owner.id, 'published')).toEqual({
      status: 200,
      body: { key: 'published', creditsAwarded: 5000 },
    });
  });

  it('keeps a previously queued reward accepted without creating a second claim', async () => {
    const owner = await seedUnlockedUser();
    await HeldCreditRewardModel.create({
      transactionId: `gear-unlock:${owner.id}:shareproject`,
      userId: owner.id,
      credits: 5000,
      source: 'gear',
      reason: 'gear unlock: shareproject',
      description: 'Gear unlock reward: shareproject',
      status: 'held',
      heldAt: new Date(),
    });
    expect(await claim(owner.id, 'shareproject')).toEqual({
      status: 200,
      body: { key: 'shareproject', alreadyClaimed: true },
    });
    expect(await balanceOf(owner.id)).toBe(0);
    expect(await HeldCreditRewardModel.countDocuments({ userId: owner.id })).toBe(1);
  });
});
