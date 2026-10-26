import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';
import { ADMIN_PERMISSIONS } from '@bike4mind/common';
import { createMongoReplSet, settleAutoIndexBuilds } from '../__test__/createMongoServer';
import { User } from '../models/auth/UserModel';
import { assertCanRemoveFullAdmin, lockAdminMutations, prepareAdminMutationLock } from './adminMutationLock';

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await prepareAdminMutationLock();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await User.deleteMany({});
});

const seed = (username: string, isAdmin = true, adminPermissions: readonly string[] = []) =>
  User.create({ username, name: username, email: `${username}@example.com`, isAdmin, adminPermissions });
const demote = (userId: string) =>
  withTransaction(async () => {
    await lockAdminMutations();
    await assertCanRemoveFullAdmin(userId, { isAdmin: false });
    await User.updateOne({ _id: userId }, { $set: { isAdmin: false } });
  });

describe('full administrator membership serialization', () => {
  it('refuses use without an active transaction', async () => {
    await expect(lockAdminMutations()).rejects.toThrow('active transaction');
  });

  it('keeps one full administrator when two legacy demotions race', async () => {
    const first = await seed('first');
    const second = await seed('second');
    const outcomes = await Promise.allSettled([demote(String(first._id)), demote(String(second._id))]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await User.countDocuments({ isAdmin: true })).toBe(1);
  });

  it('serializes a deletion against a role demotion on another account', async () => {
    const first = await seed('delete-target');
    const second = await seed('demote-target');
    const deletion = withTransaction(async () => {
      await lockAdminMutations();
      await assertCanRemoveFullAdmin(String(first._id));
      await User.deleteOne({ _id: first._id });
    });
    const outcomes = await Promise.allSettled([deletion, demote(String(second._id))]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await User.countDocuments({ isAdmin: true })).toBe(1);
  });

  it('recognizes a full explicit grant set as a remaining administrator', async () => {
    const legacy = await seed('legacy');
    await seed('delegated-full', false, ADMIN_PERMISSIONS);
    await expect(demote(String(legacy._id))).resolves.toBeUndefined();
  });

  it('does not count partial delegated grants as full administrators', async () => {
    const legacy = await seed('legacy');
    await seed('support', false, ['support:read']);
    await expect(demote(String(legacy._id))).rejects.toThrow('last remaining');
    expect(await User.countDocuments({ isAdmin: true })).toBe(1);
  });

  it('allows removing the legacy flag when a complete grant set remains', async () => {
    const legacy = await seed('both', true, ADMIN_PERMISSIONS);
    await expect(demote(String(legacy._id))).resolves.toBeUndefined();
    expect(await User.countDocuments({ isAdmin: false })).toBe(1);
  });

  it('rolls back the protected change when a subsequent strict audit fails', async () => {
    const first = await seed('first');
    await seed('second');
    await expect(
      withTransaction(async () => {
        await lockAdminMutations();
        await assertCanRemoveFullAdmin(String(first._id));
        await User.deleteOne({ _id: first._id });
        throw new Error('Audit unavailable');
      })
    ).rejects.toThrow('Audit unavailable');
    expect(await User.countDocuments({ isAdmin: true })).toBe(2);
  });
});
