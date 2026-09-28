import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Session } from './SessionModel';

/**
 * autoIndex builds declared indexes in the background and nothing awaits the result, so an index
 * spec MongoDB rejects is silently never created. Model.init() is the one call that surfaces it.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('Session indexes', () => {
  it('builds every declared index', async () => {
    await expect(Session.init()).resolves.not.toThrow();

    const built = new Set((await Session.collection.listIndexes().toArray()).map(index => index.name));
    const declared = Session.schema.indexes().map(([fields, options]) => options?.name ?? indexName(fields));

    expect(declared.filter(name => !built.has(name))).toEqual([]);
  });
});

function indexName(fields: Record<string, unknown>) {
  return Object.entries(fields)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}
