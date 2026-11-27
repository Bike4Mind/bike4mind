import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';

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
  await User.deleteMany({});
});

const makeUser = (overrides: Record<string, unknown> = {}) =>
  User.create({ username: `user-${Math.random()}`, name: 'Test User', ...overrides });

describe('UserRepository.findCreditPurchaseStamps', () => {
  it('returns the purchase date for a user with a stamp', async () => {
    const stamp = new Date('2026-10-01T12:00:00Z');
    const user = await makeUser({ lastCreditsPurchasedAt: stamp });

    const stamps = await userRepository.findCreditPurchaseStamps([String(user._id)]);

    expect(stamps.get(String(user._id))).toEqual(stamp);
  });

  it('returns null for a user without the field', async () => {
    const user = await makeUser();

    const stamps = await userRepository.findCreditPurchaseStamps([String(user._id)]);

    expect(stamps.has(String(user._id))).toBe(true);
    expect(stamps.get(String(user._id))).toBeNull();
  });

  it('omits a valid id that is not a user', async () => {
    const stamps = await userRepository.findCreditPurchaseStamps(['507f1f77bcf86cd799439011']);
    expect(stamps.size).toBe(0);
  });

  it('filters invalid ids and returns an empty map when none are valid', async () => {
    const stamps = await userRepository.findCreditPurchaseStamps(['not-an-id', '']);
    expect(stamps.size).toBe(0);
  });

  it('still resolves the valid ids alongside invalid ones', async () => {
    const user = await makeUser();

    const stamps = await userRepository.findCreditPurchaseStamps(['not-an-id', String(user._id)]);

    expect([...stamps.keys()]).toEqual([String(user._id)]);
  });
});
