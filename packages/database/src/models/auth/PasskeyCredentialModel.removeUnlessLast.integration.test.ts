import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createMongoReplSet, settleAutoIndexBuilds } from '../../__test__/createMongoServer';
import { passkeyCredentialRepository, PasskeyCredentialModel } from './PasskeyCredentialModel';
import { User } from './UserModel';

/** removeUnlessLast runs in a transaction serialized on the user document, so it needs a replica set. */
let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await PasskeyCredentialModel.syncIndexes();
  await settleAutoIndexBuilds(mongoose);
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

const makeUser = async () => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id, updatedAt: new Date() });
  return _id.toHexString();
};

const makePasskey = (userId: string, credentialId = `cred-${Math.random()}`) =>
  passkeyCredentialRepository.create({
    userId,
    credentialId,
    publicKey: 'pub',
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
    name: 'Laptop',
  });

describe('passkeyCredentialRepository.removeUnlessLast', () => {
  it('removes a passkey while another remains', async () => {
    const userId = await makeUser();
    const first = await makePasskey(userId);
    await makePasskey(userId);
    expect(await passkeyCredentialRepository.removeUnlessLast(first.id, userId)).toBe('removed');
    expect(await passkeyCredentialRepository.countByUser(userId)).toBe(1);
  });

  it('refuses the last passkey without ever deleting it', async () => {
    const userId = await makeUser();
    const only = await makePasskey(userId, `cred-only-${userId}`);
    await passkeyCredentialRepository.recordUse(only.id, 7);
    expect(await passkeyCredentialRepository.removeUnlessLast(only.id, userId)).toBe('last');
    const kept = await passkeyCredentialRepository.findByCredentialId(userId, `cred-only-${userId}`);
    expect(kept?.id).toBe(only.id);
    expect(kept?.counter).toBe(7);
  });

  it('keeps exactly one passkey when the last two are removed concurrently', async () => {
    const userId = await makeUser();
    const a = await makePasskey(userId);
    const b = await makePasskey(userId);
    const outcomes = await Promise.all([
      passkeyCredentialRepository.removeUnlessLast(a.id, userId),
      passkeyCredentialRepository.removeUnlessLast(b.id, userId),
    ]);
    expect(outcomes.sort()).toEqual(['last', 'removed']);
    expect(await passkeyCredentialRepository.countByUser(userId)).toBe(1);
  }, 30000);

  it("answers not_found for another user's passkey or a malformed id, touching nothing", async () => {
    const userId = await makeUser();
    const otherUserId = await makeUser();
    const passkey = await makePasskey(userId);
    await makePasskey(userId);
    expect(await passkeyCredentialRepository.removeUnlessLast(passkey.id, otherUserId)).toBe('not_found');
    expect(await passkeyCredentialRepository.removeUnlessLast('not-an-id', userId)).toBe('not_found');
    expect(await passkeyCredentialRepository.countByUser(userId)).toBe(2);
  });
});
