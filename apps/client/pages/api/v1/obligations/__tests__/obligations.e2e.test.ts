import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObligationModel, obligationRepository } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const { lakeFiling } = vi.hoisted(() => ({ lakeFiling: { failAfterWrite: false } }));

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const on = (method: string) => (fn: (req: unknown, res: unknown) => unknown) => ((handlers[method] = fn), chain);
    const chain: Record<string, unknown> = Object.assign(
      async (req: { method: string }, res: unknown) => handlers[req.method]?.(req, res),
      { post: on('POST'), get: on('GET'), patch: on('PATCH') }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/dispatchByMethod', () => ({
  dispatchByMethod:
    (routes: Record<string, (req: unknown, res: unknown) => unknown>) => (req: { method: string }, res: unknown) =>
      routes[req.method](req, res),
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@bike4mind/server-utils/dataLakes/toAccessContext', () => ({
  toMemberAccessContext: async () => ({ userId: 'user-me' }),
}));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ isFeatureEnabled: async () => true }));
vi.mock('@server/dataLakes/lakeConfigAuditPrincipal', () => ({ lakeConfigAuditPrincipal: () => ({ kind: 'user' }) }));
vi.mock('@server/obligations/handOffDocument', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/obligations/handOffDocument')>();
  const { obligationRepository: repo } = await import('@bike4mind/database');
  return {
    ...actual,
    createHandOffDeps: () => ({
      obligations: repo,
      findFile: async () => ({ moderationStatus: 'clean' }),
      fileText: async () => '',
      listLakes: async () => [{ id: 'lake-bills', name: 'Household bills' }],
      canFund: async () => true,
      complete: async (
        _userId: string,
        _prompt: string,
        store: (reply: string, model: string) => Promise<{ value: unknown }>
      ) =>
        (
          await store(
            JSON.stringify({
              document_kind: 'invoice',
              payee: 'Acme Water Utility',
              amount: '184.37',
              currency: 'USD',
              due_date: '2026-12-04',
              destination_index: 1,
              summary: 'Water bill for October service.',
            }),
            'ops-model'
          )
        ).value,
      logger: { warn: () => {} },
    }),
  };
});
// The lake gate and membership write have their own suites; this stand-in keeps the real transaction so the
// obligation update is proven to commit or roll back with the membership row.
vi.mock('@server/dataLakes/lakeMembershipWrite', async () => {
  const { withTransaction: inTransaction } = await import('@bike4mind/database');
  const lakes: Record<string, { id: string; name: string }> = {
    'lake-bills': { id: 'lake-bills', name: 'Household bills' },
    'lake-tax': { id: 'lake-tax', name: 'Taxes' },
  };
  return {
    assertLakeMembershipWritable: async (id: string) => lakes[id],
    addFileToWritableLake: (opts: {
      lakeIdOrSlug: string;
      resolveFileId: () => string;
      alsoInTransaction: (lake: { id: string; name: string }) => Promise<unknown>;
    }) =>
      inTransaction(async () => {
        const lake = lakes[opts.lakeIdOrSlug];
        const fileId = opts.resolveFileId();
        const LakeFile =
          mongoose.models.TestLakeFile ??
          mongoose.model(
            'TestLakeFile',
            new mongoose.Schema({ lakeId: String, fileId: String }, { versionKey: false }),
            'test_lake_files'
          );
        await LakeFile.create([{ lakeId: lake.id, fileId }]);
        const extra = await opts.alsoInTransaction(lake);
        if (lakeFiling.failAfterWrite) throw new Error('membership write failed');
        return { lake, extra };
      }),
  };
});

import indexHandler from '../index';
import idHandler from '../[id]';

let database: MongoMemoryReplSet;

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri());
  await settleAutoIndexBuilds(mongoose);
  await ObligationModel.syncIndexes();
  await mongoose.connection.createCollection('test_lake_files');
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  lakeFiling.failAfterWrite = false;
  await ObligationModel.collection.deleteMany({});
  await mongoose.connection.collection('test_lake_files').deleteMany({});
});

type Handler = (req: unknown, res: unknown) => Promise<void>;
const call = async (handler: unknown, method: 'GET' | 'POST' | 'PATCH', extra: Record<string, unknown>) => {
  const { req, res } = createMocks({ method });
  Object.assign(req, { user: { id: 'user-me' }, logger: { info: vi.fn(), warn: vi.fn() }, ...extra });
  await (handler as Handler)(req, res);
  return res;
};
const handOff = async (fileId: string) => {
  const res = await call(indexHandler, 'POST', { validated: { file_id: fileId, text: 'AMOUNT DUE $184.37' } });
  return { status: res._getStatusCode(), body: res._getJSONData() as { id: string; status: string } };
};
const patch = (id: string, validated: Record<string, unknown>) =>
  call(idHandler, 'PATCH', { validated, validatedParams: { id } });
const lakeFiles = () =>
  mongoose.connection
    .collection('test_lake_files')
    .find({}, { projection: { _id: 0 } })
    .toArray();

describe('obligation routes against a real database', () => {
  it('hands off, corrects, confirms and files the scan into the chosen lake', async () => {
    const fileId = new mongoose.Types.ObjectId().toString();
    const first = await handOff(fileId);
    expect(first.status).toBe(201);
    expect((await handOff(fileId)).status).toBe(200);

    const res = await patch(first.body.id, {
      amount: { value: 190, currency: 'USD' },
      destination_lake_id: 'lake-tax',
      status: 'confirmed',
    });

    expect(res._getJSONData()).toMatchObject({
      status: 'confirmed',
      amount: { value: 190, currency: 'USD' },
      destination: { lake_id: 'lake-tax', name: 'Taxes' },
    });
    expect(await lakeFiles()).toEqual([{ lakeId: 'lake-tax', fileId }]);
    const stored = await obligationRepository.findByIdForUser(first.body.id, 'user-me');
    expect(stored).toMatchObject({ status: 'confirmed', amountValue: 190, destinationLakeId: 'lake-tax' });
    expect(stored?.confirmedAt).toBeInstanceOf(Date);
  });

  it('leaves the obligation pending when filing fails after the update was written', async () => {
    const { body } = await handOff(new mongoose.Types.ObjectId().toString());
    lakeFiling.failAfterWrite = true;

    await expect(patch(body.id, { status: 'confirmed' })).rejects.toThrow('membership write failed');

    expect(await lakeFiles()).toEqual([]);
    expect(await obligationRepository.findByIdForUser(body.id, 'user-me')).toMatchObject({
      status: 'pending',
      confirmedAt: null,
    });
  });

  it('404s another user reading or changing the obligation', async () => {
    const { body } = await handOff(new mongoose.Types.ObjectId().toString());
    const asOther = { user: { id: 'user-other' }, validatedParams: { id: body.id } };

    await expect(call(idHandler, 'GET', asOther)).rejects.toMatchObject({ statusCode: 404 });
    await expect(call(idHandler, 'PATCH', { ...asOther, validated: { status: 'confirmed' } })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await obligationRepository.findByIdForUser(body.id, 'user-me')).toMatchObject({ status: 'pending' });
  });
});
