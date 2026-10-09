import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { AdminSettings, adminSettingsRepository } from '@bike4mind/database/infra';

/**
 * The cleared-absolute-floor delete against a real AdminSettings model. A mock cannot see the
 * softDeletePlugin: a soft delete leaves a tombstone that the next save's upsert writes into
 * without reviving, so the setting would read as unset forever after one clear.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ put: (handler: (...a: unknown[]) => unknown) => handler }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: (...a: unknown[]) => unknown) => handler,
}));
vi.mock('@server/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'a'.repeat(64) } }));
vi.mock('@server/utils/publicSettingsArtifact', () => ({
  materializePublicSettingsArtifactSafe: vi.fn(() => Promise.resolve()),
}));

import handler from '../update';

const KEY = 'forcedRetrievalMinSimilarityPct';

const put = async (value: unknown) => {
  const json = vi.fn((x: unknown) => x);
  const req = {
    user: { isAdmin: true },
    ability: { can: () => true },
    body: { key: KEY, value },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, { json });
};

let mongoServer: MongoMemoryServer;
beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('settings/update clearing the absolute floor (real Mongo)', () => {
  it('a value saved after a clear is readable again', async () => {
    await put('40');
    await put('');
    expect(await adminSettingsRepository.findBySettingName(KEY)).toBeNull();

    await put('60');
    expect((await adminSettingsRepository.findBySettingName(KEY))?.settingValue).toBe(60);
    expect(await AdminSettings.collection.countDocuments({ settingName: KEY })).toBe(1);
  });
});
