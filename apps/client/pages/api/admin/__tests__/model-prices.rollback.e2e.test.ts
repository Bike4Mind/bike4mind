// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { ModelPrice, generateModelPriceSeed, modelPriceRepository } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method: string }, res: unknown) => handlers[req.method]?.(req, res), {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
      post: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.POST = fn), chain),
    });
    return chain;
  },
}));

// The audit store fails; the repository, the seed generator and withTransaction are real.
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: vi.fn(async () => {
    throw new Error('audit down');
  }),
}));

import handler from '../model-prices';

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const post = (body: object) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as unknown as { user: { id: string; isAdmin: boolean } }).user = { id: 'admin-1', isAdmin: true };
  return (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res);
};

const seedOperatorRow = (modelId: string, pricing: Record<string, { input: number; output: number }>) =>
  modelPriceRepository.append({
    modelId,
    unit: 'per_token',
    pricing,
    effectiveFrom: new Date(Date.now() - 60_000),
    note: 'invoice A',
    repricedBy: 'admin-0',
  });

describe('POST /api/admin/model-prices rolls the price row back when the strict audit fails', () => {
  it('reprice: no new ModelPrice row persists', async () => {
    await seedOperatorRow('gpt-x', { '0': { input: 4e-6, output: 16e-6 } });

    await expect(
      post({ modelId: 'gpt-x', unit: 'per_token', pricing: { '0': { input: 5e-6, output: 20e-6 } }, note: 'invoice B' })
    ).rejects.toThrow('audit down');

    const rows = await ModelPrice.find({ modelId: 'gpt-x' }).lean();
    expect(rows.map(r => r.note)).toEqual(['invoice A']);
  });

  it('revert-to-seed: no new ModelPrice row persists', async () => {
    const entry = (await generateModelPriceSeed()).find(e => e.unit === 'per_token');
    expect(entry).toBeDefined();
    await seedOperatorRow(entry!.modelId, { '0': { input: 1e-6, output: 2e-6 } });

    await expect(post({ modelId: entry!.modelId, unit: 'per_token', action: 'revert-to-seed' })).rejects.toThrow(
      'audit down'
    );

    const rows = await ModelPrice.find({ modelId: entry!.modelId }).lean();
    expect(rows.map(r => r.note)).toEqual(['invoice A']);
  });
});
