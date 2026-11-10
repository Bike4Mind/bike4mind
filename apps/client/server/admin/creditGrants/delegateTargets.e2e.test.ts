// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { User } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { assertDelegateCanCreditUsers } from './delegateTargets';

const delegate = { id: '111111111111111111111111', adminPermissions: ['credits:adjust'] };
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: MongoMemoryServer;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await User.deleteMany({});
});

describe('bulk credit target projection (real Mongo)', () => {
  it.each([{ isAdmin: true }, { adminPermissions: ['support:read'] }])(
    'reads admin-access fields from storage before allowing a delegate batch: %j',
    async access => {
      const target = await User.create({ name: 'Target', username: 'target', ...access });
      await expect(assertDelegateCanCreditUsers(delegate, [target.id], 'credit')).rejects.toThrow(
        'Only full administrators'
      );
    }
  );
  it('allows an ordinary target', async () => {
    const target = await User.create({ name: 'Target', username: 'target' });
    await expect(assertDelegateCanCreditUsers(delegate, [target.id], 'credit')).resolves.toBeUndefined();
  });
});
