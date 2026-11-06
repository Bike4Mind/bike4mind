import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { ApiKeyUsageLog, AuthSessionModel, Organization, User, UserApiKey } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { searchAdminEntities } from './searchEntities';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
const userId = new Types.ObjectId();
const orgId = new Types.ObjectId();

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Promise.all(
    [User, UserApiKey, Organization, AuthSessionModel, ApiKeyUsageLog].map(model => model.createIndexes())
  );
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await Promise.all(
    [User, UserApiKey, Organization, AuthSessionModel, ApiKeyUsageLog].map(model => model.collection.deleteMany({}))
  );
  await User.collection.insertOne({
    _id: userId,
    name: 'Example user',
    username: 'example',
    email: 'Example@example.com',
    stripeCustomerId: 'cus_example',
  });
  await Organization.collection.insertOne({ _id: orgId, name: 'Example org', stripeCustomerId: 'cus_example' });
  await UserApiKey.collection.insertOne({
    userId: String(userId),
    name: 'Example key',
    keyPrefix: 'b4m_live_abcdef1',
    keyHash: 'never-return-this',
    encryptedKey: 'secret',
  });
});

describe('indexed entity lookup', () => {
  it('resolves email case-insensitively and returns a masked whitelist', async () => {
    expect(await searchAdminEntities('EXAMPLE@example.com')).toEqual([
      { type: 'user', id: String(userId), displayName: 'Example user', secondary: 'E***@example.com' },
    ]);
  });
  it('resolves IDs, names and ambiguous billing identifiers', async () => {
    expect((await searchAdminEntities(String(userId)))[0].type).toBe('user');
    expect((await searchAdminEntities(String(orgId)))[0].type).toBe('organization');
    expect((await searchAdminEntities('example ORG'))[0].id).toBe(String(orgId));
    expect((await searchAdminEntities('cus_example')).map(result => result.type)).toEqual(['user', 'organization']);
    expect(await searchAdminEntities('Example')).toEqual([]);
    await Organization.collection.insertOne({ name: String(userId) });
    expect((await searchAdminEntities(String(userId))).map(result => result.type)).toEqual(['user', 'organization']);
  });
  it('resolves key prefixes to their owner without returning secret fields', async () => {
    const results = await searchAdminEntities('b4m_live_abcd');
    expect(results.map(result => result.type)).toEqual(['user', 'key']);
    expect(results[1]).toMatchObject({ userId: String(userId), secondary: 'b4m_live_abcdef1...' });
    expect(JSON.stringify(results)).not.toMatch(/never-return-this|secret|keyHash|encryptedKey/);
    await UserApiKey.collection.updateOne({}, { $set: { keyPrefix: 'b4m_live_abc' } });
    expect((await searchAdminEntities('b4m_live_abc')).map(result => result.type)).toEqual(['user', 'key']);
  });
  it('resolves both sign-in and API usage IPs and deduplicates owners', async () => {
    await AuthSessionModel.collection.insertOne({
      sid: 'example',
      userId: String(userId),
      device: { ip: '192.0.2.1' },
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await ApiKeyUsageLog.collection.insertOne({
      userId: String(userId),
      keyId: 'key',
      ipAddress: '192.0.2.1',
      timestamp: new Date(),
    });
    expect((await searchAdminEntities('192.0.2.1')).map(result => result.id)).toEqual([String(userId)]);
  });
  it('returns the five most recently active IP owners, newest first', async () => {
    const owners = Array.from({ length: 6 }, () => new Types.ObjectId());
    await User.collection.insertMany(owners.map((_id, i) => ({ _id, name: `Owner ${i}`, username: `owner${i}` })));
    const base = Date.now();
    await AuthSessionModel.collection.insertMany(
      owners.map((owner, i) => ({
        sid: `recency-${i}`,
        userId: String(owner),
        device: { ip: '192.0.2.9' },
        lastUsedAt: new Date(base + i * 1000),
        expiresAt: new Date(base + 60_000),
      }))
    );
    expect((await searchAdminEntities('192.0.2.9')).map(result => result.id)).toEqual(
      owners.slice(1).reverse().map(String)
    );
  });
  it('keeps other users on the IP visible when one API user fills the usage rows', async () => {
    const busy = new Types.ObjectId();
    const quiet = new Types.ObjectId();
    await User.collection.insertMany([
      { _id: busy, name: 'Busy', username: 'busy' },
      { _id: quiet, name: 'Quiet', username: 'quiet' },
    ]);
    const base = Date.now();
    await ApiKeyUsageLog.collection.insertMany([
      { userId: String(quiet), keyId: 'quiet-key', ipAddress: '192.0.2.10', timestamp: new Date(base - 60_000) },
      ...Array.from({ length: 120 }, (_, i) => ({
        userId: String(busy),
        keyId: 'busy-key',
        ipAddress: '192.0.2.10',
        timestamp: new Date(base + i),
      })),
    ]);
    expect((await searchAdminEntities('192.0.2.10')).map(result => result.id)).toEqual([String(busy), String(quiet)]);
  });
  it('caps each result group', async () => {
    await Organization.collection.insertMany(Array.from({ length: 10 }, () => ({ name: 'Common org' })));
    expect(await searchAdminEntities('Common org')).toHaveLength(5);
  });
});
