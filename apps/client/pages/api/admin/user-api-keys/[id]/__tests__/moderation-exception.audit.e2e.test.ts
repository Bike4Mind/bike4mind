import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import { ApiKeyStatus } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { AdminAuditLogModel, User, adminAuditLogRepository } from '@bike4mind/database';
import { UserApiKey, userApiKeyRepository } from '@bike4mind/database/auth';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
type Handler = (request: Request, response: Response) => Promise<unknown>;
const captured = vi.hoisted(() => ({ put: null as Handler | null }));
vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    put: (handler: Handler) => {
      captured.put = handler;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => () => undefined }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));

await import('../moderation-exception');
let replicaSet: Awaited<ReturnType<typeof createMongoReplSet>>;
const ownerId = new mongoose.Types.ObjectId().toString();
const adminId = new mongoose.Types.ObjectId().toString();
const logger = new Logger({ metadata: { service: 'moderation-exception-audit-fixture' } });
beforeAll(async () => {
  replicaSet = await createMongoReplSet();
  await mongoose.connect(replicaSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await UserApiKey.createCollection();
  await AdminAuditLogModel.createCollection();
});
afterAll(async () => {
  await mongoose.disconnect();
  await replicaSet?.stop();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await UserApiKey.deleteMany({});
  await User.deleteMany({});
  // The production audit model is append-only; raw deletion is confined to this disposable replica set.
  await AdminAuditLogModel.collection.deleteMany({});
});
const seedKey = async () => {
  await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(ownerId), username: 'fixture-owner' });
  const key = await UserApiKey.collection.insertOne({
    userId: ownerId,
    name: 'Fixture key',
    keyPrefix: `b4m_live_fixture_${new mongoose.Types.ObjectId().toString()}`,
    status: ApiKeyStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return key.insertedId.toString();
};
const call = async (id: string, categories: string[], reason: string) => {
  const { req, res } = createMocks({
    method: 'PUT',
    url: `/api/admin/user-api-keys/${id}/moderation-exception`,
    query: { id },
    body: { categories, reason },
  });
  Object.assign(req, { user: { id: adminId, username: 'Fixture admin', isAdmin: true }, logger });
  const handler = captured.put;
  if (!handler) throw new Error('Moderation exception route was not captured');
  await handler(req as unknown as Request, res as unknown as Response);
  expect(res._getStatusCode()).toBe(200);
};

// Only transport middleware is doubled: key reads/writes, transaction retries, and the strict audit writer are real.
describe('moderation exception audit transactions', () => {
  it('re-reads the audit preimage after another administrator commits during the request', async () => {
    const id = await seedKey();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const readException = userApiKeyRepository.findModerationException.bind(userApiKeyRepository);
    let heldFirstRead = false;
    vi.spyOn(userApiKeyRepository, 'findModerationException').mockImplementation(async keyId => {
      const previous = await readException(keyId);
      if (!heldFirstRead) {
        heldFirstRead = true;
        entered.resolve();
        await release.promise;
      }
      return previous;
    });
    const second = call(id, ['VIOLENCE'], 'Second administrator');
    // Attach settlement immediately so a failing route never leaves an unhandled rejection.
    const secondSettled = Promise.allSettled([second]);
    try {
      await Promise.race([entered.promise, second]);
      expect(heldFirstRead).toBe(true);
      await call(id, ['violence'], 'First administrator');
    } finally {
      release.resolve();
      await secondSettled;
    }
    await second;
    const rows = await AdminAuditLogModel.find({}).lean();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.reason === 'First administrator')?.changes).toEqual([
      { field: 'moderationException.categories', before: [], after: ['violence'] },
    ]);
    expect(rows.find(row => row.reason === 'Second administrator')?.changes).toEqual([
      { field: 'moderationException.categories', before: ['violence'], after: ['VIOLENCE'] },
    ]);
    expect((await userApiKeyRepository.findModerationException(id))?.moderationException.categories).toEqual([
      'VIOLENCE',
    ]);
  });

  it.each(['removed', 'soft-deleted'] as const)(
    'refuses an update when the key is %s after the initial route read',
    async deletion => {
      const id = await seedKey();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readKey = userApiKeyRepository.findById.bind(userApiKeyRepository);
      vi.spyOn(userApiKeyRepository, 'findById').mockImplementationOnce(async keyId => {
        const key = await readKey(keyId);
        entered.resolve();
        await release.promise;
        return key;
      });
      const change = call(id, ['violence'], 'Update removed key');
      const settled = Promise.allSettled([change]);
      try {
        await Promise.race([entered.promise, change]);
        if (deletion === 'removed') {
          const deleted = await UserApiKey.collection.deleteOne({ _id: new mongoose.Types.ObjectId(id) });
          expect(deleted.deletedCount).toBe(1);
        } else {
          const deleted = await UserApiKey.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(id) },
            { $set: { deletedAt: new Date() } }
          );
          expect(deleted.matchedCount).toBe(1);
        }
      } finally {
        release.resolve();
        await settled;
      }
      await expect(change).rejects.toMatchObject({ statusCode: 404 });
      expect(await AdminAuditLogModel.countDocuments()).toBe(0);
    }
  );

  it.each([
    ['replace', ['VIOLENCE']],
    ['clear', []],
  ] as const)('rolls back %s when the strict audit append fails', async (_label, categories) => {
    const id = await seedKey();
    await userApiKeyRepository.setModerationException(id, {
      categories: ['violence'],
      reason: 'Initial approval',
      setBy: adminId,
      setAt: new Date(),
    });
    vi.spyOn(adminAuditLogRepository, 'append').mockRejectedValueOnce(new Error('strict audit unavailable'));
    await expect(call(id, [...categories], 'Review update')).rejects.toThrow('strict audit unavailable');
    expect((await userApiKeyRepository.findModerationException(id))?.moderationException.categories).toEqual([
      'violence',
    ]);
    expect(await AdminAuditLogModel.countDocuments()).toBe(0);
  });
});
