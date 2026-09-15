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

describe('UserRepository.findActiveEmailsByIds', () => {
  it('returns the email for an active, emailed user', async () => {
    const user = await makeUser({ email: 'a@example.com' });

    const rows = await userRepository.findActiveEmailsByIds([String(user._id)]);

    expect(rows).toEqual([{ id: String(user._id), email: 'a@example.com' }]);
  });

  it('excludes a user with no email', async () => {
    const user = await makeUser();

    const rows = await userRepository.findActiveEmailsByIds([String(user._id)]);

    expect(rows).toEqual([]);
  });

  it('excludes a user carrying deletedAt', async () => {
    const user = await makeUser({ email: 'gone@example.com' });
    // deletedAt is not a declared schema field on User (mirrors findBySlackUserId's same
    // filter) - write it via the raw collection so the query is exercised regardless of how
    // the field would actually land on a document.
    await User.collection.updateOne({ _id: user._id }, { $set: { deletedAt: new Date() } });

    const rows = await userRepository.findActiveEmailsByIds([String(user._id)]);

    expect(rows).toEqual([]);
  });

  it('ignores an unknown id rather than throwing', async () => {
    const rows = await userRepository.findActiveEmailsByIds(['507f1f77bcf86cd799439011']);
    expect(rows).toEqual([]);
  });

  it('short-circuits on an empty id list without querying', async () => {
    const rows = await userRepository.findActiveEmailsByIds([]);
    expect(rows).toEqual([]);
  });

  it('resolves multiple ids in one call', async () => {
    const a = await makeUser({ email: 'a@example.com' });
    const b = await makeUser({ email: 'b@example.com' });

    const rows = await userRepository.findActiveEmailsByIds([String(a._id), String(b._id)]);

    expect(rows.map(r => r.email).sort()).toEqual(['a@example.com', 'b@example.com']);
  });
});
