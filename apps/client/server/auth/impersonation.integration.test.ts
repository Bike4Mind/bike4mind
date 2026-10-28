import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Request } from 'express';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { SupportAccess, AuthSessionModel, withTransaction } from '@bike4mind/database';
const h = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionForActor: h.audit }));
import { endImpersonation } from './impersonation';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let db: MongoMemoryReplSet;
const actor = { kind: 'user' as const, scope: 'platform' as const, userId: 'admin', name: 'Admin', wasAdmin: true };
beforeAll(async () => {
  db = await createMongoReplSet();
  await mongoose.connect(db.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await db?.stop();
});
beforeEach(async () => {
  await SupportAccess.deleteMany({});
  await AuthSessionModel.deleteMany({});
  h.audit.mockReset().mockResolvedValue({ id: 'audit' });
  await withTransaction(async () => {
    await SupportAccess.create([
      {
        sid: 'sid',
        userId: 'customer',
        adminId: 'admin',
        reason: 'Internal support reason',
        startedAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 60_000),
      },
    ]);
    await AuthSessionModel.create([
      {
        sid: 'sid',
        userId: 'customer',
        createdVia: 'impersonation',
        refreshTokenHash: 'hash',
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
        impersonatedBy: 'admin',
      },
    ]);
  });
});
describe('support access transaction boundaries', () => {
  it('rolls end and revocation back when audit fails', async () => {
    h.audit.mockRejectedValue(new Error('audit unavailable'));
    await expect(endImpersonation({} as Request, 'sid', actor)).rejects.toThrow('audit unavailable');
    expect((await SupportAccess.findOne({ sid: 'sid' }))?.endedAt).toBeNull();
    expect((await AuthSessionModel.findOne({ sid: 'sid' }))?.revokedAt).toBeNull();
  });
  it('concurrent return and expiry commit one attributed end with capped duration', async () => {
    await Promise.all([endImpersonation({} as Request, 'sid', actor), endImpersonation({} as Request, 'sid', actor)]);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({ userId: 'admin', impersonatedUserId: 'customer' });
    expect((await SupportAccess.findOne({ sid: 'sid' }))?.endedAt).toBeInstanceOf(Date);
    expect((await AuthSessionModel.findOne({ sid: 'sid' }))?.revokedAt).toBeInstanceOf(Date);
  });
});
