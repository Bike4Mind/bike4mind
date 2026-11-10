import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { DataLakeResearchConfigModel } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Importing './index' (for AvailableMigrations) pulls in a migration that reads SST bindings at load.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921240060_research-config-source-tiers';
import { AvailableMigrations } from './index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.dropDatabase();
});

const UPDATED_AT = new Date('2026-01-01T00:00:00.000Z');

const insertLegacy = async (allowedDomains?: string[]) => {
  const { insertedId } = await DataLakeResearchConfigModel.collection.insertOne({
    dataLakeId: 'lake-1',
    name: 'Legacy',
    query: 'q',
    maxResults: 10,
    maxProposals: 5,
    ...(allowedDomains ? { allowedDomains } : {}),
    blockedDomains: ['bad.example'],
    minRelevance: 0.5,
    costCeilingMicroUsd: 1000,
    proposedTags: [],
    trigger: 'on_demand',
    createdByUserId: 'u1',
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
  });
  return insertedId;
};

const read = (id: unknown) => DataLakeResearchConfigModel.collection.findOne({ _id: id as never });

describe('research-config-source-tiers migration (real DB)', () => {
  it('has a unique id below the fail-closed backfill', () => {
    expect(AvailableMigrations.filter(m => m.id === migration.id)).toHaveLength(1);
    expect(migration.id).toBeLessThan(20260922000001);
  });

  it('maps a non-empty allow list to the review list with other sites dropped', async () => {
    const id = await insertLegacy(['a.example', 'b.example']);
    await migration.up();
    const doc = await read(id);
    expect(doc).toMatchObject({
      reviewDomains: ['a.example', 'b.example'],
      trustedDomains: [],
      unlistedSources: 'drop',
      blockedDomains: ['bad.example'],
    });
  });

  it('maps an empty allow list to other sites going to review', async () => {
    const id = await insertLegacy([]);
    await migration.up();
    expect(await read(id)).toMatchObject({ reviewDomains: [], trustedDomains: [], unlistedSources: 'review' });
  });

  it('maps an absent allow list to other sites going to review', async () => {
    const id = await insertLegacy();
    await migration.up();
    expect(await read(id)).toMatchObject({ reviewDomains: [], unlistedSources: 'review' });
  });

  it('keeps allowedDomains and updatedAt untouched', async () => {
    const id = await insertLegacy(['a.example']);
    await migration.up();
    const doc = await read(id);
    expect(doc?.allowedDomains).toEqual(['a.example']);
    expect(doc?.updatedAt).toEqual(UPDATED_AT);
  });

  it('is idempotent and leaves an already-tiered config alone', async () => {
    const legacy = await insertLegacy(['a.example']);
    const { insertedId: tiered } = await DataLakeResearchConfigModel.collection.insertOne({
      dataLakeId: 'lake-1',
      name: 'Tiered',
      trustedDomains: ['t.example'],
      reviewDomains: ['r.example'],
      unlistedSources: 'review',
      allowedDomains: [],
    });
    await migration.up();
    const first = await read(legacy);
    await migration.up();
    expect(await read(legacy)).toEqual(first);
    expect(await read(tiered)).toMatchObject({
      trustedDomains: ['t.example'],
      reviewDomains: ['r.example'],
      unlistedSources: 'review',
    });
  });

  it('down unsets the new fields and leaves allowedDomains', async () => {
    const id = await insertLegacy(['a.example']);
    await migration.up();
    await migration.down();
    const doc = await read(id);
    expect(doc).not.toHaveProperty('unlistedSources');
    expect(doc).not.toHaveProperty('reviewDomains');
    expect(doc?.allowedDomains).toEqual(['a.example']);
  });
});
