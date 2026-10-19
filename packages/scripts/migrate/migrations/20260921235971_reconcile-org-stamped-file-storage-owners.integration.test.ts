import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { FabFile, Organization, User, userRepository } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration, { MAX_ATTEMPTS } from './20260921235971_reconcile-org-stamped-file-storage-owners';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});

const chargedAt = new Date('2026-10-01T00:00:00Z');

const insertUser = async (currentStorageSize: number) => {
  const _id = new Types.ObjectId();
  // username and email carry unique indexes.
  await User.collection.insertOne({ _id, username: `u${_id}`, email: `${_id}@test.local`, currentStorageSize });
  return String(_id);
};

const insertOrg = async (currentStorageSize: number) => {
  const _id = new Types.ObjectId();
  await Organization.collection.insertOne({ _id, currentStorageSize });
  return String(_id);
};

const insertFile = (row: { userId: string; organizationId?: string | null; fileSize: number; deletedAt?: Date }) =>
  FabFile.collection.insertOne({ deletedAt: null, storageChargedAt: chargedAt, ...row });

const counterOf = async (model: typeof User | typeof Organization, id: string) =>
  (await model.collection.findOne({ _id: new Types.ObjectId(id) }))?.currentStorageSize;

describe('reconcile-org-stamped-file-storage-owners migration (real DB)', () => {
  it('moves org-stamped bytes off the uploader counter and onto the org counter', async () => {
    const orgId = await insertOrg(0);
    // Charged under the old rule: 100 personal + 50 org-stamped bytes, all on the uploader.
    const uploader = await insertUser(150);
    const untouched = await insertUser(999);
    await insertFile({ userId: uploader, fileSize: 100 });
    await insertFile({ userId: uploader, organizationId: orgId, fileSize: 50 });
    await insertFile({ userId: untouched, fileSize: 1 });

    await migration.up();

    expect(await counterOf(User, uploader)).toBe(100);
    expect(await counterOf(Organization, orgId)).toBe(50);
    // Not tied to any org-stamped row, so out of the cutover's scope even though it drifted.
    expect(await counterOf(User, untouched)).toBe(999);
  });

  it('heals an uploader whose only org-stamped file is already soft-deleted', async () => {
    const orgId = await insertOrg(0);
    const uploader = await insertUser(70);
    await insertFile({ userId: uploader, fileSize: 40 });
    await insertFile({ userId: uploader, organizationId: orgId, fileSize: 30, deletedAt: new Date() });

    await migration.up();

    expect(await counterOf(User, uploader)).toBe(40);
    expect(await counterOf(Organization, orgId)).toBe(0);
  });

  it('is a no-op on re-run', async () => {
    const orgId = await insertOrg(0);
    const uploader = await insertUser(150);
    await insertFile({ userId: uploader, fileSize: 100 });
    await insertFile({ userId: uploader, organizationId: orgId, fileSize: 50 });
    await migration.up();
    const setSpy = vi.spyOn(userRepository, 'setCurrentStorageIfUnchanged');

    await migration.up();

    expect(setSpy).not.toHaveBeenCalled();
    expect(await counterOf(User, uploader)).toBe(100);
    expect(await counterOf(Organization, orgId)).toBe(50);
  });

  it('retries a lost compare-and-set and gives up after the attempt bound', async () => {
    const orgId = await insertOrg(0);
    const uploader = await insertUser(150);
    await insertFile({ userId: uploader, organizationId: orgId, fileSize: 50 });
    const setSpy = vi.spyOn(userRepository, 'setCurrentStorageIfUnchanged').mockResolvedValue(false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await migration.up();

    expect(setSpy).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(setSpy).toHaveBeenCalledWith(uploader, 150, 0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(uploader));
    expect(await counterOf(User, uploader)).toBe(150);
    // One owner's conflict does not stop the rest.
    expect(await counterOf(Organization, orgId)).toBe(50);
  });

  it('settles on a retry once the counter stops moving', async () => {
    const orgId = await insertOrg(0);
    const uploader = await insertUser(150);
    await insertFile({ userId: uploader, organizationId: orgId, fileSize: 50 });
    vi.spyOn(userRepository, 'setCurrentStorageIfUnchanged').mockResolvedValueOnce(false);

    await migration.up();

    expect(await counterOf(User, uploader)).toBe(0);
  });
});
