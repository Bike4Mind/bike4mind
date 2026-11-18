import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';
import type { SpendFreezeActor, SpendFreezeScope } from '@bike4mind/common';
import { createMongoReplSet, MONGO_TEST_TIMEOUT_MS, settleAutoIndexBuilds } from '../../__test__/createMongoServer';
import { SpendFreeze, spendFreezeRepository } from './SpendFreezeModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// A standalone mongod cannot run transactions, so only a replica set shows whether the write escapes one.
let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await SpendFreeze.createCollection();
  await SpendFreeze.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(async () => {
  await SpendFreeze.deleteMany({});
});

const admin: SpendFreezeActor = { kind: 'admin', userId: 'admin-1' };
const userScope = (): SpendFreezeScope => ({ scopeType: 'User', scopeId: new mongoose.Types.ObjectId().toString() });
const freezeInput = (scope: SpendFreezeScope) => ({ ...scope, reason: 'test', actor: admin, frozenAt: new Date() });

// The thrown error stands in for a failing audit append after the repository write.
const auditFailure = new Error('audit append failed');

describe('spendFreezeRepository inside withTransaction', () => {
  it('rolls back createActive when the transaction aborts', async () => {
    const scope = userScope();

    await expect(
      withTransaction(async () => {
        await spendFreezeRepository.createActive(freezeInput(scope));
        throw auditFailure;
      })
    ).rejects.toBe(auditFailure);

    expect(await SpendFreeze.countDocuments({})).toBe(0);
    expect(await spendFreezeRepository.findActive(scope)).toBeNull();
  });

  it('rolls back liftActive when the transaction aborts, leaving the freeze active', async () => {
    const scope = userScope();
    await spendFreezeRepository.createActive(freezeInput(scope));

    await expect(
      withTransaction(async () => {
        await spendFreezeRepository.liftActive(scope, {
          liftedBy: admin,
          liftReason: 'resolved',
          liftedAt: new Date(),
        });
        throw auditFailure;
      })
    ).rejects.toBe(auditFailure);

    const active = await spendFreezeRepository.findActive(scope);
    expect(active).not.toBeNull();
    expect(active?.liftedAt).toBeFalsy();
  });
});
