import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userApiKeyService, userService } from '@bike4mind/services';
import { ApiKeyScope, ApiKeyStatus } from '@bike4mind/common';
import {
  mongoose,
  User,
  userRepository,
  Organization,
  friendshipRepository,
  creditTransactionRepository,
  CreditTransaction,
} from '@bike4mind/database';
import { userApiKeyRepository, UserApiKey } from '@bike4mind/database/auth';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;

// Realtime teardown is the only side effect mocked; the key repository is the real one.
const endConnections = vi.fn(async () => {});
const adminAdapters = {
  db: {
    users: userRepository,
    organizations: Organization,
    friendship: friendshipRepository,
    userApiKeys: userApiKeyRepository,
    realtimeConnections: { endConnections },
    creditTransactions: creditTransactionRepository,
  },
};
const validationAdapters = { db: { userApiKeys: userApiKeyRepository } };

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await User.createCollection();
  await UserApiKey.createCollection();
  await CreditTransaction.createCollection();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  endConnections.mockClear();
  await User.collection.deleteMany({});
  await UserApiKey.collection.deleteMany({});
});

async function createAdminAndMemberWithKey() {
  const admin = await User.create({
    username: 'synthetic-admin',
    name: 'Synthetic Admin',
    email: 'admin@example.com',
    emailVerified: true,
    isAdmin: true,
  });
  const member = await User.create({
    username: 'synthetic-member',
    name: 'Synthetic Member',
    email: 'member@example.com',
    emailVerified: true,
  });
  const minted = await userApiKeyService.createUserApiKey(
    member.id,
    { name: 'synthetic key', scopes: [ApiKeyScope.AI_CHAT], metadata: { createdFrom: 'api' } },
    { db: { userApiKeys: userApiKeyRepository, agents: { findById: async () => null } }, trust: { status: 'trusted' } }
  );
  return { admin, member, minted };
}

describe('admin suspend revokes the account API keys (real Mongo)', () => {
  it('rejects a key minted before the suspend once the account is banned', async () => {
    const { admin, member, minted } = await createAdminAndMemberWithKey();

    const before = await userApiKeyService.validateUserApiKey(minted.key, validationAdapters);
    expect(before).toMatchObject({ isValid: true, userId: member.id, keyId: minted.id });

    await userService.adminUpdateUser(admin.id, { id: member.id, isBanned: true }, adminAdapters);

    const stored = await UserApiKey.findById(minted.id).lean();
    expect(stored?.status).toBe(ApiKeyStatus.DISABLED);
    expect(stored?.revokedAt).toBeInstanceOf(Date);

    const after = await userApiKeyService.validateUserApiKey(minted.key, validationAdapters);
    expect(after.isValid).toBe(false);
  });

  it('does not reactivate the key when the account is reinstated', async () => {
    const { admin, member, minted } = await createAdminAndMemberWithKey();

    await userService.adminUpdateUser(admin.id, { id: member.id, isBanned: true }, adminAdapters);
    await userService.adminUpdateUser(admin.id, { id: member.id, isBanned: false }, adminAdapters);

    expect((await User.findById(member.id).lean())?.isBanned).toBe(false);
    const stored = await UserApiKey.findById(minted.id).lean();
    expect(stored?.status).toBe(ApiKeyStatus.DISABLED);
    expect(stored?.revokedAt).toBeInstanceOf(Date);

    const after = await userApiKeyService.validateUserApiKey(minted.key, validationAdapters);
    expect(after.isValid).toBe(false);
  });
});
