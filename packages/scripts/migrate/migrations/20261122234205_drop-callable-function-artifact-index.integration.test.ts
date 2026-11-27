import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { CallableFunction } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20261122234205_drop-callable-function-artifact-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await CallableFunction.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const indexNames = async () => (await CallableFunction.collection.indexes()).map(i => i.name);

describe('drop-callable-function-artifact-index migration (real DB)', () => {
  it('drops the per-artifact unique index, keeps the name index, and runs again without error', async () => {
    await CallableFunction.collection.createIndex(
      { ownerType: 1, ownerKey: 1, 'pin.artifactId': 1 },
      { unique: true, name: 'callablefn_owner_artifact' }
    );
    expect(await indexNames()).toContain('callablefn_owner_artifact');

    await migration.up();
    await migration.up();
    // What the earlier ensure-index migration and autoIndex build: every index the current schema declares.
    await CallableFunction.createIndexes();

    expect(await indexNames()).not.toContain('callablefn_owner_artifact');
    expect(await indexNames()).toContain('callablefn_owner_slug');
  });
});
