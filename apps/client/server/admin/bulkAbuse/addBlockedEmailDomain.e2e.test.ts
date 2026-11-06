import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { AdminAuditLogModel } from '@bike4mind/database';
import { AdminSettings } from '@bike4mind/database/infra';

const invalidateSettingsCache = vi.fn();
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  invalidateSettingsCache: (...args: unknown[]) => invalidateSettingsCache(...args),
}));

import { addBlockedEmailDomain } from './addBlockedEmailDomain';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

afterEach(async () => {
  invalidateSettingsCache.mockClear();
  await mongoose.connection.dropDatabase();
});

const fakeReq = {
  user: { id: 'a'.repeat(24), username: 'admin', name: 'Admin', email: 'admin@example.com', isAdmin: true },
  headers: {},
  url: '/api/admin/abuse/bulk-execute',
  requestId: 'req-1',
} as unknown as Parameters<typeof addBlockedEmailDomain>[0];

const storedList = async () =>
  (await AdminSettings.findOne({ settingName: 'blockedEmailDomains' }).lean())?.settingValue;
const auditRows = () => AdminAuditLogModel.countDocuments({ action: 'settings.admin_settings.updated' });

describe('addBlockedEmailDomain on a real replica set', () => {
  it('appends a normalized domain, keeps the existing list, audits once and drops the cache', async () => {
    await AdminSettings.create({ settingName: 'blockedEmailDomains', settingValue: ['a.com'] });

    expect(await addBlockedEmailDomain(fakeReq, '@Sub.B.com')).toBe(true);

    expect(await storedList()).toEqual(['a.com', 'sub.b.com']);
    expect(await auditRows()).toBe(1);
    expect(invalidateSettingsCache).toHaveBeenCalledTimes(1);
    expect(invalidateSettingsCache).toHaveBeenCalledWith('blockedEmailDomains');
  });

  it('creates the setting when none exists', async () => {
    expect(await addBlockedEmailDomain(fakeReq, 'b.com')).toBe(true);
    expect(await storedList()).toEqual(['b.com']);
  });

  it('is a no-op, with no audit and no cache drop, when the domain is already listed', async () => {
    await AdminSettings.create({ settingName: 'blockedEmailDomains', settingValue: ['b.com'] });

    expect(await addBlockedEmailDomain(fakeReq, 'B.com')).toBe(false);

    expect(await storedList()).toEqual(['b.com']);
    expect(await auditRows()).toBe(0);
    expect(invalidateSettingsCache).not.toHaveBeenCalled();
  });

  it('refuses a public suffix without writing', async () => {
    await expect(addBlockedEmailDomain(fakeReq, 'github.io')).rejects.toThrow('public suffix');
    expect(await storedList()).toBeUndefined();
  });
});
