import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';
import { createMongoReplSet, settleAutoIndexBuilds, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { DataLakeResearchConfigModel, dataLakeResearchConfigRepository as repo } from './DataLakeResearchConfigModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  mongoose.set('transactionAsyncLocalStorage', true);
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await DataLakeResearchConfigModel.createCollection();
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

describe('DataLakeResearchConfigRepository.updateConfig under concurrent transactions', () => {
  it('retries a write conflict instead of reporting the config as not found', async () => {
    const doc = await repo.createConfig({
      dataLakeId: 'lake-1',
      name: 'Weekly sweep',
      trigger: 'on_demand',
      cadence: 'off',
      source: 'search',
      query: 'coastal erosion',
      createdByUserId: 'user-1',
      maxResults: 10,
      maxProposals: 5,
      minRelevance: 0.6,
      costCeilingMicroUsd: 50_000,
    } as Parameters<typeof repo.createConfig>[0]);
    const id = doc.id;

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withTransaction(
          async () => {
            const updated = await repo.updateConfig(id, 'lake-1', { name: `rename-${i}` });
            // The service throws on null before commit, so a swallowed conflict surfaces as not found.
            if (!updated) throw new Error('not found');
            // Hold the write uncommitted so the sibling transactions collide with it.
            await new Promise(resolve => setTimeout(resolve, 50));
            return updated;
          },
          { maxRetries: 10 }
        )
      )
    );

    expect(results.every(r => r !== null)).toBe(true);
  });
});
