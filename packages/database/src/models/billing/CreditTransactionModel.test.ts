import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { CreditTransaction, creditTransactionRepository } from './CreditTransactionModel';
import { CreditHolderType } from '@bike4mind/common';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await CreditTransaction.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await CreditTransaction.deleteMany({});
});

const ORG = 'org-1';
const day = (n: number) => new Date(Date.UTC(2026, 0, n));

/** Raw insert so createdAt is deterministic (mongoose timestamps would stamp now). */
const seed = (rows: Array<Record<string, unknown>>) =>
  CreditTransaction.collection.insertMany(
    rows.map(r => ({
      ownerId: ORG,
      ownerType: CreditHolderType.Organization,
      credits: 10,
      type: 'text_generation_usage',
      createdAt: day(1),
      updatedAt: day(1),
      ...r,
    }))
  );

describe('CreditTransactionRepository.queryLedgerPage', () => {
  it('paginates newest-first and returns the full total', async () => {
    await seed([
      { createdAt: day(1) },
      { createdAt: day(2) },
      { createdAt: day(3) },
      { createdAt: day(4) },
      { createdAt: day(5) },
    ]);

    const page1 = await creditTransactionRepository.queryLedgerPage(ORG, CreditHolderType.Organization, {
      limit: 2,
      skip: 0,
    });
    expect(page1.total).toBe(5);
    expect(page1.data).toHaveLength(2);
    expect(page1.data.map(d => d.createdAt.getTime())).toEqual([day(5).getTime(), day(4).getTime()]);

    const page3 = await creditTransactionRepository.queryLedgerPage(ORG, CreditHolderType.Organization, {
      limit: 2,
      skip: 4,
    });
    expect(page3.total).toBe(5);
    expect(page3.data).toHaveLength(1);
    expect(page3.data[0].createdAt.getTime()).toBe(day(1).getTime());
  });

  it('scopes strictly to the owner id and type', async () => {
    await seed([{ credits: 10 }]);
    await seed([{ ownerId: 'org-2', credits: 999 }]);
    await CreditTransaction.collection.insertMany([
      {
        ownerId: ORG,
        ownerType: CreditHolderType.User,
        credits: 999,
        type: 'text_generation_usage',
        createdAt: day(1),
        updatedAt: day(1),
      },
    ]);

    const res = await creditTransactionRepository.queryLedgerPage(ORG, CreditHolderType.Organization, {
      limit: 50,
      skip: 0,
    });
    expect(res.total).toBe(1);
    expect(res.data[0].credits).toBe(10);
  });

  it('filters by transaction type, source, and model', async () => {
    await seed([
      { type: 'text_generation_usage', source: 'web', model: 'claude-sonnet-4-5' },
      { type: 'completion_api_usage', source: 'api', model: 'gpt-4o' },
      { type: 'tool_usage', source: 'web', model: 'claude-sonnet-4-5' },
      { type: 'purchase', source: undefined, model: undefined },
    ]);

    const byType = await creditTransactionRepository.queryLedgerPage(ORG, CreditHolderType.Organization, {
      transactionTypes: ['text_generation_usage', 'tool_usage'],
      limit: 50,
      skip: 0,
    });
    expect(byType.total).toBe(2);

    const bySource = await creditTransactionRepository.queryLedgerPage(ORG, CreditHolderType.Organization, {
      source: 'api',
      limit: 50,
      skip: 0,
    });
    expect(bySource.total).toBe(1);
    expect(bySource.data[0].type).toBe('completion_api_usage');

    const byModel = await creditTransactionRepository.queryLedgerPage(ORG, CreditHolderType.Organization, {
      model: 'claude-sonnet-4-5',
      limit: 50,
      skip: 0,
    });
    expect(byModel.total).toBe(2);
  });

  it('filters to the trailing day window', async () => {
    await seed([{ createdAt: day(1) }, { createdAt: day(2) }]);
    // Move both far into the past, then confirm the window excludes them.
    await CreditTransaction.collection.updateMany({}, { $set: { createdAt: new Date('2020-01-01') } });
    const res = await creditTransactionRepository.queryLedgerPage(ORG, CreditHolderType.Organization, {
      days: 30,
      limit: 50,
      skip: 0,
    });
    expect(res.total).toBe(0);
    expect(res.data).toHaveLength(0);
  });
});
