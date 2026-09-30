/**
 * Real-Mongo regression: converted service writes no longer revert a concurrent atomic write that
 * lands in their read-to-write window. `BaseRepository.update` `$set`s every key it is handed, so
 * the old whole-doc writes put the read-time snapshot back over a credit `$inc` or a member add.
 *
 * Each case wraps the service's read so the concurrent write fires right after it, runs the real
 * service against real repositories, then asserts the concurrent write survived. Consumes the
 * built dist (`pnpm turbo:core:build`), and runs in the integration lane only
 * (`CLIENT_TEST_LANE=integration`, see apps/client/vitest.config.mts).
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Organization, User, organizationRepository, userRepository } from '@bike4mind/database';
import { organizationService, userService } from '@bike4mind/services';
import { Permission, type IUserDocument } from '@bike4mind/common';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await Promise.all([User.deleteMany({}), Organization.deleteMany({})]);
});

/** `repo` with `method` replaced by one that reads, then runs `inWindow` before handing the doc back. */
function withWindow<R extends object, K extends keyof R>(repo: R, method: K, inWindow: () => Promise<unknown>): R {
  const original = repo[method] as unknown as (...a: unknown[]) => Promise<unknown>;
  return Object.create(repo, {
    [method]: {
      value: async (...args: unknown[]) => {
        const doc = await original.apply(repo, args);
        await inWindow();
        return doc;
      },
    },
  });
}

describe('money: a converted user write keeps a concurrent credit $inc', () => {
  it('recordPolicyAcceptance does not revert a credit deduction landing after its read', async () => {
    const seeded = await User.create({
      username: 'payer',
      name: 'Payer',
      email: 'payer@example.com',
      currentCredits: 100,
    });
    const id = String(seeded._id);

    await userService.recordPolicyAcceptance(
      { userId: id, ageAttestation: true },
      {
        db: {
          users: {
            findById: withWindow(userRepository, 'findById', () => userRepository.incrementCredits(id, -30)).findById,
            update: data => userRepository.update(data),
          },
        },
      }
    );

    const after = await User.findById(id).lean();
    expect(after?.currentCredits).toBe(70);
    expect(after?.ageAttestedAdult).toBe(true);
  });
});

describe('org: removing a member keeps concurrent roster and credit writes', () => {
  it('revokeAccess keeps a member added, and a credit $inc, landing after its read', async () => {
    const org = await Organization.create({
      name: 'Acme',
      userId: 'owner',
      managerId: 'leaver',
      adminUserIds: ['leaver', 'stayer'],
      users: [
        { userId: 'leaver', permissions: [Permission.read] },
        { userId: 'stayer', permissions: [Permission.read] },
      ],
      userDetails: [
        { id: 'leaver', email: 'l@example.com', name: 'Leaver', usedCredits: 0 },
        { id: 'stayer', email: 's@example.com', name: 'Stayer', usedCredits: 0 },
      ],
    });
    const orgId = String(org._id);

    const concurrent = async () => {
      await organizationRepository.addMemberRaisingSeats(orgId, { userId: 'joiner', permissions: [Permission.read] });
      await organizationRepository.updateUserDetails(orgId, 'stayer', { creditsDelta: 5 });
    };

    await organizationService.revokeAccess(
      { id: 'owner', isAdmin: true } as IUserDocument,
      { id: orgId, userId: 'leaver' },
      {
        db: {
          organizations: withWindow(organizationRepository, 'findById', concurrent),
          users: userRepository,
          groups: { findByOrganization: async () => [] },
          dataLakes: { findByOrganizationId: async () => [], update: async () => null },
          dataLakeAccessGrants: {
            listByPrincipal: async () => [],
            listActiveByLakes: async () => [],
            upsertGrant: async () => undefined,
          },
          lakeConfigChangeEvents: { record: async () => undefined },
        },
      } as never
    );

    const after = await Organization.findById(orgId).lean();
    expect(after?.users.map(u => u.userId).sort()).toEqual(['joiner', 'stayer']);
    expect(after?.userDetails?.map(d => [d.id, d.usedCredits])).toEqual([['stayer', 5]]);
    expect(after?.adminUserIds).toEqual(['stayer']);
    expect(after?.managerId).toBeNull();
  });
});
