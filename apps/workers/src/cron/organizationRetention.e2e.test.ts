import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { Organization } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

const effects = vi.hoisted(() => ({ cleanup: vi.fn(), receipts: vi.fn(), PolicyChanged: class extends Error {} }));
vi.mock('@workers/organizations/retentionCleanup', () => ({
  cleanupOrganizationRetention: effects.cleanup,
  RetentionPolicyChangedError: effects.PolicyChanged,
}));
vi.mock('@bike4mind/server-utils/utils/generatedFileCleanup', () => ({ retryGeneratedFileCleanup: effects.receipts }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));
vi.mock('sst', () => ({ Resource: {} }));
import { organizationRetentionFilter, runOrganizationRetention } from './organizationRetention';

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

beforeEach(async () => {
  await Organization.collection.deleteMany({});
  effects.cleanup.mockReset().mockResolvedValue(undefined);
  effects.receipts.mockReset().mockResolvedValue(0);
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

it('selects only stored finite policies at the actual scheduler bounds', async () => {
  const expected: string[] = [];
  const rows = [null, 0, 1, 36500, 36501].flatMap(days =>
    ['chats', 'files', 'media'].map(kind => {
      const id = new mongoose.Types.ObjectId();
      if (days === 1 || days === 36500) expected.push(id.toString());
      return {
        _id: id,
        personal: false,
        retentionVersion: 1,
        retentionPolicy: { chats: null, files: null, media: null, [kind]: days },
      };
    })
  );
  await Organization.collection.insertMany([
    ...rows,
    { personal: true, retentionVersion: 1, retentionPolicy: { chats: 1, files: null, media: null } },
    { personal: false, retentionVersion: 0, retentionPolicy: { chats: 1, files: null, media: null } },
    { personal: false, retentionVersion: 1, retentionPolicy: { chats: 'invalid', files: null, media: null } },
  ]);
  expect((await Organization.find(organizationRetentionFilter)).map(org => org.id).sort()).toEqual(expected.sort());
});

it('uses the deployed opted-in sweep index without scanning unrelated organizations', async () => {
  const definition = Organization.schema.indexes().find(([, options]) => options.name === 'retention_opted_in_sweep');
  if (!definition) throw new Error('Missing production opted-in sweep index');
  const keys = z.object({ personal: z.literal(1), retentionLastSweptAt: z.literal(1), _id: z.literal(1) }).strict();
  const options = z
    .object({
      name: z.literal('retention_opted_in_sweep'),
      partialFilterExpression: z.object({ retentionVersion: z.object({ $gt: z.literal(0) }).strict() }).strict(),
      background: z.boolean().optional(),
    })
    .strict();
  await Organization.collection.createIndex(keys.parse(definition[0]), options.parse(definition[1]));
  await Organization.collection.insertMany([
    ...Array.from({ length: 5000 }, () => ({
      personal: false,
      retentionVersion: 0,
      retentionLastSweptAt: new Date('2026-01-01'),
      retentionPolicy: { chats: null, files: null, media: null },
    })),
    ...Array.from({ length: 100 }, () => ({
      personal: false,
      retentionVersion: 1,
      retentionLastSweptAt: new Date('2026-01-01'),
      retentionPolicy: { chats: null, files: null, media: null },
    })),
    ...Array.from({ length: 3 }, () => ({
      personal: false,
      retentionVersion: 1,
      retentionLastSweptAt: new Date('2026-02-01'),
      retentionPolicy: { chats: 1, files: null, media: null },
    })),
  ]);
  const explain = z
    .object({
      queryPlanner: z.object({ winningPlan: z.unknown() }),
      executionStats: z.object({ totalDocsExamined: z.number(), nReturned: z.number() }),
    })
    .parse(
      await Organization.find(organizationRetentionFilter)
        .sort({ retentionLastSweptAt: 1, _id: 1 })
        .limit(20)
        .explain('executionStats')
    );
  expect(JSON.stringify(explain.queryPlanner.winningPlan)).toContain('retention_opted_in_sweep');
  expect(explain.executionStats.nReturned).toBe(3);
  expect(explain.executionStats.totalDocsExamined).toBeLessThan(200);
});
