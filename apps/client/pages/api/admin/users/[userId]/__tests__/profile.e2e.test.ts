import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createMocks } from 'node-mocks-http';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';
import { User } from '@bike4mind/database';

// Drives the real repository, userService and User model on a replica set, so the transaction,
// the unique indexes and the required-name rule are the real ones; the unit test mocks all three.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const h = vi.hoisted(() => ({ record: vi.fn(), publish: vi.fn(), stepUp: vi.fn() }));

vi.mock('@server/utils/adminAudit', () => ({
  parseAdminActionReason: (reason: string) => reason,
  recordAdminActionFromRequest: h.record,
}));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: h.stepUp }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        patch: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PATCH = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

import handler from '../profile';

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  process.env.APP_URL ??= 'https://app.test';
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
  await User.syncIndexes();
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
beforeEach(async () => {
  await User.deleteMany({});
  h.record.mockReset().mockResolvedValue(undefined);
  h.publish.mockReset().mockResolvedValue(undefined);
  h.stepUp.mockReset().mockResolvedValue(undefined);
});

const seedUser = (suffix: string) =>
  User.create({ username: `user-${suffix}`, name: `User ${suffix}`, email: `user-${suffix}@example.com` });

const patch = async (userId: string, body: Record<string, unknown>) => {
  const { req, res } = createMocks({
    method: 'PATCH',
    query: { userId },
    body: { reason: 'Customer request', ...body },
  });
  Object.assign(req, { user: { id: 'admin-1', isAdmin: true }, logger: { error: vi.fn() } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

describe('PATCH /api/admin/users/:userId/profile (real repository + Mongo)', () => {
  it('writes the name and username and leaves the email for the user to verify', async () => {
    const user = await seedUser('a');

    const res = await patch(user.id, { name: 'Renamed', username: 'renamed', email: 'next@example.com' });

    expect(res._getJSONData()).toMatchObject({
      name: 'Renamed',
      username: 'renamed',
      pendingEmail: 'next@example.com',
    });
    const stored = await User.findById(user.id).lean();
    expect(stored).toMatchObject({
      name: 'Renamed',
      username: 'renamed',
      email: 'user-a@example.com',
      pendingEmail: 'next@example.com',
    });
    expect(stored?.pendingEmailToken).toEqual(expect.any(String));
    expect(h.publish.mock.calls.map(([message]) => message.to)).toEqual(['user-a@example.com', 'next@example.com']);
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.identity.updated', summary: 'updated name, username, pendingEmail' })
    );
  });

  it('rejects an email another account holds without writing anything', async () => {
    const user = await seedUser('b');
    await seedUser('c');

    await expect(patch(user.id, { name: 'Renamed', email: 'USER-C@example.com' })).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: { field: 'email' },
    });

    expect(await User.findById(user.id).lean()).toMatchObject({ name: 'User b', pendingEmail: null });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('rejects a username another account holds, case-insensitively', async () => {
    const user = await seedUser('d');
    await seedUser('e');

    await expect(patch(user.id, { username: 'USER-E' })).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: { field: 'username' },
    });
  });

  it('rolls the name, username and pending email back when the audit write fails', async () => {
    const user = await seedUser('f');
    h.record.mockRejectedValue(new Error('audit down'));

    await expect(patch(user.id, { name: 'Renamed', username: 'renamed-f', email: 'f2@example.com' })).rejects.toThrow(
      'audit down'
    );

    expect(await User.findById(user.id).lean()).toMatchObject({
      name: 'User f',
      username: 'user-f',
      pendingEmail: null,
    });
    expect(h.publish).not.toHaveBeenCalled();
  });
});
