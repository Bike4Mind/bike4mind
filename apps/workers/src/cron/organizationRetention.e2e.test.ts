import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { Organization } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

const effects = vi.hoisted(() => ({ cleanup: vi.fn(), receipts: vi.fn() }));
vi.mock('@workers/organizations/retentionCleanup', () => ({ cleanupOrganizationRetention: effects.cleanup }));
vi.mock('@bike4mind/server-utils/utils/generatedFileCleanup', () => ({ retryGeneratedFileCleanup: effects.receipts }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));
vi.mock('sst', () => ({ Resource: {} }));
import { runOrganizationRetention } from './organizationRetention';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;
beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

it('forever policies cannot consume all rotation slots before an enabled organization', async () => {
  const active = new mongoose.Types.ObjectId();
  await Organization.collection.insertMany([
    ...Array.from({ length: 25 }, () => ({
      personal: false,
      retentionVersion: 1,
      retentionPolicy: { chats: null, files: null, media: null },
      retentionLastSweptAt: new Date('2026-01-01T00:00:00Z'),
    })),
    {
      _id: active,
      personal: false,
      retentionVersion: 1,
      retentionPolicy: { chats: 30, files: null, media: null },
      retentionLastSweptAt: new Date('2026-01-02T00:00:00Z'),
    },
    { personal: true, retentionVersion: 1, retentionPolicy: { chats: 30, files: null, media: null } },
    { personal: false, retentionVersion: 0, retentionPolicy: { chats: 30, files: null, media: null } },
    { personal: false, retentionVersion: 1, retentionPolicy: { chats: 'invalid', files: null, media: null } },
  ]);
  await runOrganizationRetention();
  expect(effects.cleanup.mock.calls.map(([id]) => id)).toEqual([active.toString()]);
  expect(effects.receipts).toHaveBeenCalledOnce();
});
