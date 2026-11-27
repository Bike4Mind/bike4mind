import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { AuthSessionModel, User, authSessionRepository } from '@bike4mind/database';
import { verifyJwtPayload, type JwtPayloadClaims } from './verifyJwtPayload';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Drives the real verifier against a real database: revoking a session, or the impersonating admin's
 * access, must reject the very next request made with an access token that is still within its TTL.
 */

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
beforeEach(async () => {
  await User.deleteMany({});
  await AuthSessionModel.deleteMany({});
});

const makeUser = async (name: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const user = await User.create({
    name,
    username: `${name}-${suffix}`,
    email: `${name}-${suffix}@example.com`,
    ...extra,
  });
  return String(user.id);
};

const makeSession = async (sid: string, userId: string, extra: Record<string, unknown> = {}) => {
  const expiresAt = new Date(Date.now() + 3_600_000);
  await AuthSessionModel.create({
    sid,
    userId,
    createdVia: 'otc',
    refreshTokenHash: 'hash',
    lastUsedAt: new Date(),
    expiresAt,
    ...extra,
  });
};

const authenticate = async (claims: JwtPayloadClaims): Promise<unknown> => {
  let result: unknown;
  await verifyJwtPayload(claims, (_err, user) => {
    result = user;
  });
  return result;
};

describe('verifyJwtPayload revocation', () => {
  it('rejects the next request once a normal session is revoked', async () => {
    const userId = await makeUser('member');
    await makeSession('sid-member', userId);
    const claims = { id: userId, sid: 'sid-member', tokenVersion: 0, typ: 'access' };

    expect(await authenticate(claims)).toMatchObject({ id: userId, sid: 'sid-member' });

    await authSessionRepository.revokeBySid('sid-member');

    expect(await authenticate(claims)).toBe(false);
  });

  describe('impersonation session', () => {
    const setup = async () => {
      const adminId = await makeUser('admin', { isAdmin: true });
      const customerId = await makeUser('customer');
      await makeSession('sid-support', customerId, {
        createdVia: 'impersonation',
        impersonatedBy: adminId,
        impersonationExpiresAt: new Date(Date.now() + 3_600_000),
      });
      const claims = { id: customerId, sid: 'sid-support', tokenVersion: 0, typ: 'access', impersonatedBy: adminId };
      expect(await authenticate(claims)).toMatchObject({ id: customerId, impersonatedBy: adminId });
      return { adminId, claims };
    };

    it('rejects the next request once the support session is revoked', async () => {
      const { claims } = await setup();

      await authSessionRepository.revokeBySid('sid-support');

      expect(await authenticate(claims)).toBe(false);
    });

    it('rejects the next request once the admin loses admin access', async () => {
      const { adminId, claims } = await setup();

      await User.updateOne({ _id: adminId }, { $set: { isAdmin: false, adminPermissions: [] } });

      expect(await authenticate(claims)).toBe(false);
    });

    it('rejects the next request once the admin is banned', async () => {
      const { adminId, claims } = await setup();

      await User.updateOne({ _id: adminId }, { $set: { isBanned: true } });

      expect(await authenticate(claims)).toBe(false);
    });
  });
});
