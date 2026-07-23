import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { UserApiKey } from '../UserApiKeyModel';
import { CcBridgeDevice, ccBridgeDeviceRepository } from '../CcBridgeDeviceModel';
import { ApiKeyScope, ApiKeyStatus } from '@bike4mind/common';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await UserApiKey.syncIndexes();
  // Deliberately no CcBridgeDevice.syncIndexes(): its userId_lastSeenAt_active
  // partial index uses `$exists: false`, which Mongo rejects in a
  // partialFilterExpression. Pre-existing and unrelated to revocation.
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await UserApiKey.deleteMany({});
  await CcBridgeDevice.deleteMany({});
});

let seq = 0;

// keyPrefix is uniquely indexed and the soft-delete plugin keeps removed docs,
// so each key needs its own prefix even across cleared tests.
async function pairDevice(userId = 'u1') {
  seq += 1;
  const key = await UserApiKey.create({
    userId,
    name: 'bridge key',
    keyHash: '$2b$12$abcdefghijklmnopqrstuv',
    keyPrefix: `b4m_live_bridge${String(seq).padStart(3, '0')}`,
    scopes: [ApiKeyScope.AI_GENERATE],
    metadata: { createdFrom: 'bridge' as const },
  });
  const device = await CcBridgeDevice.create({
    userId,
    deviceLabel: `laptop-${seq}`,
    apiKeyId: key.id,
    pairedAt: new Date(),
  });
  return { key, device };
}

describe('ccBridgeDeviceRepository.revoke', () => {
  it('disables the underlying key and stamps the revocation audit trail', async () => {
    const { key, device } = await pairDevice();

    const revoked = await ccBridgeDeviceRepository.revoke(device.id, 'u1');

    expect(revoked).toBe(true);
    const loaded = await UserApiKey.findById(key.id);
    expect(loaded?.status).toBe(ApiKeyStatus.DISABLED);
    expect(loaded?.revokedAt).toBeInstanceOf(Date);
    expect(loaded?.revokedBy).toBe('u1');
    expect(loaded?.revokedReason).toBe('Bridge device revoked');
  });

  it('leaves the key untouched when the device belongs to another user', async () => {
    const { key, device } = await pairDevice('u1');

    const revoked = await ccBridgeDeviceRepository.revoke(device.id, 'someone-else');

    expect(revoked).toBe(false);
    const loaded = await UserApiKey.findById(key.id);
    expect(loaded?.status).toBe(ApiKeyStatus.ACTIVE);
    expect(loaded?.revokedAt).toBeUndefined();
  });

  it('preserves the original stamp if the key was already disabled', async () => {
    const { key, device } = await pairDevice();
    const firstRevokedAt = new Date('2020-01-01T00:00:00Z');
    await UserApiKey.updateOne(
      { _id: key.id },
      { $set: { status: ApiKeyStatus.DISABLED, revokedAt: firstRevokedAt, revokedReason: 'Revoked by user' } }
    );

    await ccBridgeDeviceRepository.revoke(device.id, 'u1');

    const loaded = await UserApiKey.findById(key.id);
    expect(loaded?.revokedAt?.toISOString()).toBe(firstRevokedAt.toISOString());
    expect(loaded?.revokedReason).toBe('Revoked by user');
  });
});
