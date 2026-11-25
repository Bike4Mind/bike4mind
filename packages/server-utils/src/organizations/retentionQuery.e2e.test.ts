import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { z } from 'zod';
import { FabFileSourceType } from '@bike4mind/common';
import { FabFile, Session } from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../database/src/__test__/createMongoServer';
import { retentionFileFilter, retentionSessionIdPages } from './retentionPolicy';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const target = 'abcdefabcdefabcdefabcdef';
const foreign = 'fedcbafedcbafedcbafedcba';
const cutoff = new Date('2026-10-12T00:00:00Z');
const createdAt = new Date('2026-10-01T00:00:00Z');
const indexKeys = z.record(z.string(), z.union([z.literal(1), z.literal(-1)]));
const indexOptions = z
  .object({
    name: z.string(),
    partialFilterExpression: z.record(z.string(), z.object({ $exists: z.literal(true) }).strict()),
    background: z.boolean().optional(),
  })
  .strict();
const explainSchema = z.object({
  queryPlanner: z.object({ winningPlan: z.unknown() }),
  executionStats: z.object({ totalDocsExamined: z.number(), nReturned: z.number() }),
});
let database: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  for (const name of ['retention_files_present', 'retention_generated_files_present']) {
    const definition = FabFile.schema.indexes().find(([, options]) => options.name === name);
    if (!definition) throw new Error(`Missing production index ${name}`);
    await FabFile.collection.createIndex(indexKeys.parse(definition[0]), indexOptions.parse(definition[1]));
  }
  const sessions = Session.schema.indexes().find(([, options]) => options.name === 'retention_sessions_present');
  if (!sessions) throw new Error('Missing production Session retention index');
  await Session.collection.createIndex(indexKeys.parse(sessions[0]), indexOptions.parse(sessions[1]));
  await FabFile.collection.insertMany([
    ...Array.from({ length: 5_000 }, () => ({ organizationId: foreign, createdAt, deletedAt: null })),
    ...Array.from({ length: 20 }, () => ({ organizationId: target, createdAt, deletedAt: null })),
    ...Array.from({ length: 20 }, () => ({
      organizationId: foreign,
      sourceMetadata: { retentionOrganizationId: target },
      sourceType: FabFileSourceType.TOOL_GENERATED,
      createdAt,
      deletedAt: null,
    })),
  ]);
  await Session.collection.insertMany([
    ...Array.from({ length: 5_000 }, () => ({ retentionOrganizationId: foreign, deletedAt: null })),
    ...Array.from({ length: 20 }, () => ({ retentionOrganizationId: target, deletedAt: null })),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

describe('production retention predicates use their deployed partial indexes', () => {
  it.each([
    [false, 'retention_files_present'],
    [true, 'retention_generated_files_present'],
  ] as const)('bounds file scans for generated=%s without a hint', async (generated, indexName) => {
    const explained = explainSchema.parse(
      await FabFile.collection
        .find(retentionFileFilter(target, cutoff, generated))
        .sort({ createdAt: 1, _id: 1 })
        .explain('executionStats')
    );
    expect(JSON.stringify(explained.queryPlanner.winningPlan)).toContain(indexName);
    expect(explained.executionStats.nReturned).toBe(20);
    expect(explained.executionStats.totalDocsExamined).toBeLessThan(100);
  });

  it('uses the actual Session pager predicate and stable sort without a hint', async () => {
    const find = vi.spyOn(Session.collection, 'find');
    const ids: string[] = [];
    for await (const page of retentionSessionIdPages(target, Date.now() + 5_000)) ids.push(...page);
    expect(ids).toHaveLength(20);
    const call = find.mock.calls.find(([filter]) => 'retentionOrganizationId' in filter);
    if (!call) throw new Error('The production pager did not issue its ownership query');
    const filter = call[0];
    find.mockRestore();
    const explained = explainSchema.parse(
      await Session.collection.find(filter).sort({ _id: 1 }).explain('executionStats')
    );
    expect(JSON.stringify(explained.queryPlanner.winningPlan)).toContain('retention_sessions_present');
    expect(explained.executionStats.nReturned).toBe(20);
    expect(explained.executionStats.totalDocsExamined).toBeLessThan(100);
  });
});
