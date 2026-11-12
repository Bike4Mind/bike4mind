import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ApiKeyStatus, CreditHolderType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { UserApiKey, userApiKeyRepository } from './UserApiKeyModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await UserApiKey.deleteMany({});
});

let seeded = 0;

const seed = async (overrides: Record<string, unknown> = {}) => {
  seeded += 1;
  const keyPrefix = `b4m_live_org_${seeded}`;
  const doc = await UserApiKey.collection.insertOne({
    userId: 'member-1',
    name: 'k',
    keyPrefix,
    status: ApiKeyStatus.ACTIVE,
    organizationId: 'org-1',
    billingOwnerType: CreditHolderType.Organization,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return { id: doc.insertedId.toString(), keyPrefix };
};

const stamp = { revokedBy: 'admin-1', revokedReason: 'org-membership-ended' };

describe('UserApiKeyRepository.revokeLiveOrgBilledByUserId', () => {
  it('disables the member keys billed to the org and stamps the revoke', async () => {
    const active = await seed();
    const limited = await seed({ status: ApiKeyStatus.RATE_LIMITED });

    const ids = await userApiKeyRepository.revokeLiveOrgBilledByUserId('member-1', 'org-1', stamp);

    expect(ids.sort()).toEqual([active.id, limited.id].sort());
    const docs = await UserApiKey.find({ _id: { $in: ids } }).lean();
    for (const doc of docs) {
      expect(doc.status).toBe(ApiKeyStatus.DISABLED);
      expect(doc.revokedBy).toBe('admin-1');
      expect(doc.revokedReason).toBe('org-membership-ended');
      expect(doc.revokedAt).toBeInstanceOf(Date);
      expect(doc.revokedBatchId).toBeUndefined();
    }
    expect(await userApiKeyRepository.findActiveByKeyPrefix(active.keyPrefix)).toBeNull();
  });

  it('leaves personal, legacy, other-org and other-member keys alone', async () => {
    const personal = await seed({ billingOwnerType: CreditHolderType.User });
    const legacy = await seed({ billingOwnerType: undefined });
    const otherOrg = await seed({ organizationId: 'org-2' });
    const otherMember = await seed({ userId: 'member-2' });

    const ids = await userApiKeyRepository.revokeLiveOrgBilledByUserId('member-1', 'org-1', stamp);

    expect(ids).toEqual([]);
    const statuses = await UserApiKey.find({
      _id: { $in: [personal.id, legacy.id, otherOrg.id, otherMember.id] },
    }).lean();
    expect(statuses.map(doc => doc.status)).toEqual(Array(4).fill(ApiKeyStatus.ACTIVE));
  });

  it('keeps the original stamp on an already-disabled key', async () => {
    const revokedAt = new Date('2026-01-01T00:00:00Z');
    const old = await seed({
      status: ApiKeyStatus.DISABLED,
      revokedAt,
      revokedBy: 'someone-else',
      revokedReason: 'leaked',
    });

    expect(await userApiKeyRepository.revokeLiveOrgBilledByUserId('member-1', 'org-1', stamp)).toEqual([]);

    const doc = await UserApiKey.findById(old.id).lean();
    expect(doc?.revokedAt?.toISOString()).toBe(revokedAt.toISOString());
    expect(doc?.revokedBy).toBe('someone-else');
    expect(doc?.revokedReason).toBe('leaked');
  });
});
