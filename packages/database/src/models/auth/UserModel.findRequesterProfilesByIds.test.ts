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

describe('UserRepository.findRequesterProfilesByIds', () => {
  it('returns name, email, current organization and a deleted flag, and nothing else of the user', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const user = await makeUser({
      email: 'a@example.com',
      organizationId: orgId,
      isAdmin: true,
      password: 'a-stored-hash',
      slackSettings: { slackUserId: 'U123' },
    });

    const rows = await userRepository.findRequesterProfilesByIds([String(user._id)]);

    expect(rows).toEqual([
      {
        id: String(user._id),
        name: 'Test User',
        email: 'a@example.com',
        organizationId: String(orgId),
        deleted: false,
      },
    ]);
  });

  it('returns a user with no organization as null', async () => {
    const user = await makeUser({ email: 'a@example.com' });

    const [row] = await userRepository.findRequesterProfilesByIds([String(user._id)]);

    expect(row.organizationId).toBeNull();
  });

  it('returns a user carrying deletedAt flagged deleted rather than dropping it', async () => {
    const user = await makeUser({ email: 'gone@example.com' });
    // deletedAt is not a declared schema field on User; write it past mongoose, as findActiveEmailsByIds' test does.
    await User.collection.updateOne({ _id: user._id }, { $set: { deletedAt: new Date() } });

    const [row] = await userRepository.findRequesterProfilesByIds([String(user._id)]);

    expect(row).toMatchObject({ id: String(user._id), deleted: true });
  });

  it('skips ids that are unknown or not ObjectId-shaped, and short-circuits on none', async () => {
    const user = await makeUser({ email: 'a@example.com' });

    const rows = await userRepository.findRequesterProfilesByIds([
      String(user._id),
      '507f1f77bcf86cd799439011',
      'a-slack-principal',
    ]);

    expect(rows.map(r => r.id)).toEqual([String(user._id)]);
    expect(await userRepository.findRequesterProfilesByIds([])).toEqual([]);
    expect(await userRepository.findRequesterProfilesByIds(['not-an-object-id'])).toEqual([]);
  });
});
