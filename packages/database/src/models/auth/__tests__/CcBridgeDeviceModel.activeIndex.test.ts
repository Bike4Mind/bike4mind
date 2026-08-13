import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { CcBridgeDevice } from '../CcBridgeDeviceModel';

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
  await CcBridgeDevice.deleteMany({});
});

// Regression for the userId_lastSeenAt_active partial index: the old
// `revokedAt: { $exists: false }` filter is rejected by Mongo (unsupported in a
// partialFilterExpression), so the index silently never built. `revokedAt: null`
// is the supported form and must cover active devices (revokedAt absent) while
// excluding revoked ones (revokedAt is a Date).
describe('CcBridgeDevice userId_lastSeenAt_active partial index', () => {
  it('syncIndexes builds the active partial index without rejection', async () => {
    await expect(CcBridgeDevice.syncIndexes()).resolves.toBeDefined();
    const indexes = await CcBridgeDevice.collection.indexes();
    const active = indexes.find(i => i.name === 'userId_lastSeenAt_active');
    expect(active).toBeDefined();
    expect(active?.partialFilterExpression).toEqual({ revokedAt: null });
  });

  it('indexes active devices (revokedAt absent) and excludes revoked ones', async () => {
    await CcBridgeDevice.syncIndexes();

    await CcBridgeDevice.create({
      userId: 'u1',
      deviceLabel: 'laptop',
      apiKeyId: 'k1',
      pairedAt: new Date(),
    });
    await CcBridgeDevice.create({
      userId: 'u1',
      deviceLabel: 'desktop',
      apiKeyId: 'k2',
      pairedAt: new Date(),
      revokedAt: new Date(),
    });

    // A partial index over {revokedAt: null} covers the active row only; asking
    // Mongo to use it (hint) returns just the indexed, active document.
    const activeOnly = await CcBridgeDevice.collection
      .find({ userId: 'u1' })
      .hint('userId_lastSeenAt_active')
      .toArray();

    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0].deviceLabel).toBe('laptop');
  });
});
