import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { DataLakeModel, dataLakeRepository } from './DataLakeModel';

/**
 * Run against a real server because the behaviour under test IS Mongo's default-application on
 * read. A pre-migration lake row has no stored `origin` key; this pins that
 * `dataLakeRepository.findById` (which does not `.lean()`) hydrates it to the schema default
 * `'curated'` rather than leaving it `undefined`.
 */

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

describe('findById origin hydration', () => {
  it('defaults a stored document with no origin key to curated', async () => {
    // Insert through the native driver, bypassing Mongoose, so no schema default is applied at
    // write time - this is what a pre-migration row actually looks like.
    const { insertedId } = await DataLakeModel.collection.insertOne({
      name: 'pre-migration lake',
      fileTagPrefix: 'pre-migration:',
      datalakeTag: 'dl-pre-migration',
      createdByUserId: 'owner-1',
      status: 'active',
    });

    const lake = await dataLakeRepository.findById(String(insertedId));

    // Both the Drive bind door (drive-sync.ts) and the unattended arm of
    // assertCanWriteDataLakeTags (authorizeLakeWrite.ts) read `lake.origin` off this same
    // hydrated document and rely on it resolving to 'curated', not undefined. A future read that
    // swapped to `.lean()` would silently stop refusing at the bind door while the ingest guard
    // kept refusing - this assertion is what would catch that divergence.
    expect(lake?.origin).toBe('curated');
  });
});
