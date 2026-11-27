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

describe('UserRepository.findOldestActiveAdminId', () => {
  it('returns null when there is no admin', async () => {
    await makeUser();

    expect(await userRepository.findOldestActiveAdminId()).toBeNull();
  });

  it('returns the first-created admin', async () => {
    const first = await makeUser({ isAdmin: true });
    await makeUser({ isAdmin: true });

    expect(await userRepository.findOldestActiveAdminId()).toBe(String(first._id));
  });

  it('skips a banned admin', async () => {
    await makeUser({ isAdmin: true, isBanned: true });
    const active = await makeUser({ isAdmin: true });

    expect(await userRepository.findOldestActiveAdminId()).toBe(String(active._id));
  });

  it('skips an admin carrying deletedAt', async () => {
    const gone = await makeUser({ isAdmin: true });
    // deletedAt is not a declared schema field on User; write it via the raw collection.
    await User.collection.updateOne({ _id: gone._id }, { $set: { deletedAt: new Date() } });
    const active = await makeUser({ isAdmin: true });

    expect(await userRepository.findOldestActiveAdminId()).toBe(String(active._id));
  });

  it('ignores older non-admin users', async () => {
    await makeUser();
    const admin = await makeUser({ isAdmin: true });

    expect(await userRepository.findOldestActiveAdminId()).toBe(String(admin._id));
  });
});
