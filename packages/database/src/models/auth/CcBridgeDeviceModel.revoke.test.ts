import { ApiKeyStatus } from '@bike4mind/common';
import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import { Connection } from '../social/ConnectionModel';
import { realtimeConnectionRepository } from '../social/realtimeConnectionRepository';
import { ccBridgeDeviceRepository } from './CcBridgeDeviceModel';
import { UserApiKey } from './UserApiKeyModel';

setupMongoTest();

const USER_ID = new Types.ObjectId().toHexString();

async function pairDevice() {
  const apiKeyId = new Types.ObjectId();
  await UserApiKey.collection.insertOne({ _id: apiKeyId, userId: USER_ID, status: ApiKeyStatus.ACTIVE });
  const device = await ccBridgeDeviceRepository.create({
    userId: USER_ID,
    deviceLabel: 'laptop',
    apiKeyId: apiKeyId.toHexString(),
    pairedAt: new Date(),
  });
  return { device, apiKeyId: apiKeyId.toHexString() };
}

const insertConnection = (connectionId: string, apiKeyId?: string) =>
  Connection.collection.insertOne({ connectionId, userId: USER_ID, ...(apiKeyId && { apiKeyId }) });

const rawConnection = (connectionId: string) => Connection.collection.findOne({ connectionId });

describe('ccBridgeDeviceRepository.revoke', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ends the device's realtime connections and leaves other connections live", async () => {
    const { device, apiKeyId } = await pairDevice();
    await insertConnection('device-socket', apiKeyId);
    await insertConnection('other-socket', new Types.ObjectId().toHexString());

    const revoked = await ccBridgeDeviceRepository.revoke(String(device._id), USER_ID);

    expect(revoked).toBe(true);
    expect((await rawConnection('device-socket'))?.endedAt).toBeInstanceOf(Date);
    expect((await rawConnection('other-socket'))?.endedAt).toBeUndefined();
  });

  it('still revokes the device and disables its key when ending connections fails', async () => {
    const { device, apiKeyId } = await pairDevice();
    vi.spyOn(realtimeConnectionRepository, 'endConnections').mockRejectedValue(new Error('prune failed'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(ccBridgeDeviceRepository.revoke(String(device._id), USER_ID)).resolves.toBe(true);

    const key = await UserApiKey.collection.findOne({ _id: new Types.ObjectId(apiKeyId) });
    expect(key?.status).toBe(ApiKeyStatus.DISABLED);
    expect((await ccBridgeDeviceRepository.findById(String(device._id)))?.revokedAt).toBeInstanceOf(Date);
  });
});
