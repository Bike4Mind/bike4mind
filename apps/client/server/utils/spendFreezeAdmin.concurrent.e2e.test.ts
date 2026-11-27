import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { AuditActor, SpendFreezeScope } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import { AdminAuditLogModel, SpendFreeze } from '@bike4mind/database';
import { spendFreezeService } from '@bike4mind/services';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { buildSpendFreezeAdapters } from './spendFreezeAdmin';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  mongoServer = await createMongoReplSet();
  await mongoose.connect(mongoServer.getUri());
  await settleAutoIndexBuilds(mongoose);
  await SpendFreeze.syncIndexes();
});
beforeEach(async () => {
  await SpendFreeze.deleteMany({});
  await AdminAuditLogModel.collection.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const auditActor: AuditActor = { kind: 'user', scope: 'platform', userId: 'admin-1', name: 'Admin', wasAdmin: true };

describe('freezeSpend under concurrent admin requests', () => {
  it('creates one freeze and one audit row when two transactions race on the same scope', async () => {
    const scope: SpendFreezeScope = { scopeType: 'User', scopeId: new mongoose.Types.ObjectId().toString() };
    const adapters = buildSpendFreezeAdapters(logger as never);
    const freeze = () =>
      withTransaction(session =>
        spendFreezeService.freezeSpend(
          {
            scope,
            reason: 'race',
            actor: { kind: 'admin', userId: 'admin-1' },
            audit: { actor: auditActor, context: { source: 'admin_ui' } },
            session,
          },
          adapters
        )
      );

    const results = await Promise.all([freeze(), freeze()]);

    expect(results.map(r => r.created).sort()).toEqual([false, true]);
    expect(results[0].freeze.id).toBe(results[1].freeze.id);
    expect(await SpendFreeze.countDocuments({ ...scope, active: true })).toBe(1);
    expect(await AdminAuditLogModel.collection.countDocuments({ action: 'spend.freeze.applied' })).toBe(1);
  });
});
