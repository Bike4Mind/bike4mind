import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { AuthEventModel, User } from '@bike4mind/database';
import {
  createMongoServer,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { findLinkedAdvisoryAccounts } from './linkedAdvisoryAccounts';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const now = new Date('2026-11-01T12:00:00Z');
const recent = new Date(now.getTime() - 60_000);
const ip = '198.51.100.10';
const otherIp = '203.0.113.20';
const id = (value: number) => value.toString(16).padStart(24, '0');
let database: MongoMemoryServer;
const addUser = (value: number, address: string | null, overrides: Record<string, unknown> = {}) =>
  User.collection.insertOne({
    _id: new mongoose.Types.ObjectId(id(value)),
    name: 'Example account',
    createdAt: recent,
    signupMeta: { ip: address, ja4: 'shared-fingerprint' },
    isBanned: false,
    ...overrides,
  });
const addLogin = (value: number, address: string, createdAt = recent) =>
  AuthEventModel.collection.insertOne({ userId: id(value), ip: address, type: 'login', createdAt });

beforeAll(async () => {
  database = await createMongoServer();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  await User.collection.deleteMany({});
  await AuthEventModel.collection.deleteMany({});
});

describe('linked advisory candidate discovery', () => {
  it.each(['signup', 'login'] as const)(
    'finds exact %s IP matches against either candidate signup or login',
    async kind => {
      await addUser(1, kind === 'signup' ? ip : otherIp);
      if (kind === 'login') await addLogin(1, ip);
      await addUser(2, ip);
      await addUser(3, otherIp);
      await addLogin(3, ip);
      const result = await findLinkedAdvisoryAccounts([id(1)], now);
      expect(result.accounts.map(account => account.userId)).toEqual([id(2), id(3)]);
      expect(result.accounts[0].links).toContainEqual({
        sourceUserId: id(1),
        ip,
        sourceKind: kind,
        candidateKind: 'signup',
      });
      expect(result.accounts[1].links).toContainEqual({
        sourceUserId: id(1),
        ip,
        sourceKind: kind,
        candidateKind: 'login',
      });
      expect(result.truncated).toBe(false);
    }
  );

  it('does not follow a second hop or match names, JA4 or network prefixes alone', async () => {
    await addUser(1, ip);
    await addUser(2, ip);
    await addLogin(2, otherIp);
    await addUser(3, otherIp);
    await addUser(4, '198.51.100.11');
    await addUser(5, null);
    expect((await findLinkedAdvisoryAccounts([id(1)], now)).accounts.map(account => account.userId)).toEqual([id(2)]);
  });

  it('deduplicates events and excludes deleted, suspended and out-of-window candidates', async () => {
    await addUser(1, ip);
    await addUser(2, null);
    for (let index = 0; index < 3; index++) await addLogin(2, ip);
    await addUser(3, ip, { deletedAt: recent });
    await addUser(4, ip, { isBanned: true });
    await addUser(5, ip, { createdAt: new Date(now.getTime() - 8 * 24 * 60 * 60_000) });
    const result = await findLinkedAdvisoryAccounts([id(1)], now);
    expect(result.accounts.map(account => account.userId)).toEqual([id(2)]);
    expect(result.accounts[0].links).toHaveLength(1);
    const user = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id(2)) });
    expect(user?.isBanned).toBe(false);
    expect(user?.riskScore).toBeUndefined();
  });

  it('discounts high-population addresses by distinct account count', async () => {
    for (let index = 1; index <= 26; index++) await addUser(index, ip);
    expect((await findLinkedAdvisoryAccounts([id(1)], now)).accounts).toEqual([]);
  });

  it('marks incomplete population scans as truncated instead of assuming a rare address', async () => {
    await addUser(1, ip);
    await addUser(2, null);
    await AuthEventModel.collection.insertMany(
      Array.from({ length: 2_001 }, () => ({ userId: id(2), ip, type: 'login', createdAt: recent }))
    );
    expect(await findLinkedAdvisoryAccounts([id(1)], now)).toEqual({ accounts: [], truncated: true });
  });

  it('ignores invalid and missing IP values and expired login observations', async () => {
    await addUser(1, '198.51.100.0/24');
    await addUser(2, '198.51.100.0/24');
    await addLogin(1, ip, new Date(now.getTime() - 8 * 24 * 60 * 60_000));
    await addUser(3, ip);
    expect((await findLinkedAdvisoryAccounts([id(1)], now)).accounts).toEqual([]);
  });

  it('bounds per-account provenance and reports capped evidence', async () => {
    await addUser(1, null);
    await addUser(2, null);
    await addUser(3, null);
    for (let index = 10; index <= 20; index++) {
      const address = `198.51.100.${index}`;
      await addLogin(1, address);
      await addLogin(2, address);
      await addLogin(3, address);
    }
    const result = await findLinkedAdvisoryAccounts([id(1), id(2)], now);
    expect(result.accounts.map(account => account.userId)).toEqual([id(3)]);
    expect(result.accounts[0].links).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  it('propagates a source read failure instead of returning an empty successful scan', async () => {
    await addUser(1, ip);
    const read = vi.spyOn(AuthEventModel, 'find').mockImplementationOnce(() => {
      throw new Error('source unavailable');
    });
    try {
      await expect(findLinkedAdvisoryAccounts([id(1)], now)).rejects.toThrow('source unavailable');
    } finally {
      read.mockRestore();
    }
  });
});
