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

describe('CreditTransactionRepository.apiKeyUsageForOwner', () => {
  const recent = () => new Date();

  it('groups completion_api_usage by apiKeyId with spend magnitude and token sums', async () => {
    await seed([
      {
        type: 'completion_api_usage',
        apiKeyId: 'key-a',
        credits: -50,
        inputTokens: 1000,
        outputTokens: 400,
        createdAt: recent(),
      },
      {
        type: 'completion_api_usage',
        apiKeyId: 'key-a',
        credits: -30,
        inputTokens: 500,
        outputTokens: 100,
        createdAt: recent(),
      },
      {
        type: 'completion_api_usage',
        apiKeyId: 'key-b',
        credits: -200,
        inputTokens: 3000,
        outputTokens: 900,
        createdAt: recent(),
      },
      // No apiKeyId (web usage) - excluded.
      { type: 'text_generation_usage', credits: -999, createdAt: recent() },
    ]);

    const rows = await creditTransactionRepository.apiKeyUsageForOwner(ORG, CreditHolderType.Organization);

    expect(rows).toHaveLength(2);
    // Biggest spender first; credits reported as positive magnitude.
    expect(rows).toMatchObject([
      { apiKeyId: 'key-b', requests: 1, creditsSpent: 200, inputTokens: 3000, outputTokens: 900 },
      { apiKeyId: 'key-a', requests: 2, creditsSpent: 80, inputTokens: 1500, outputTokens: 500 },
    ]);
  });

  it('scopes to the owner and the trailing window', async () => {
    await seed([{ type: 'completion_api_usage', apiKeyId: 'key-a', credits: -10, createdAt: recent() }]);
    await seed([
      { ownerId: 'org-2', type: 'completion_api_usage', apiKeyId: 'key-x', credits: -999, createdAt: recent() },
    ]);
    const scoped = await creditTransactionRepository.apiKeyUsageForOwner(ORG, CreditHolderType.Organization);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].apiKeyId).toBe('key-a');

    await CreditTransaction.collection.updateMany({}, { $set: { createdAt: new Date('2020-01-01') } });
    const windowed = await creditTransactionRepository.apiKeyUsageForOwner(ORG, CreditHolderType.Organization, 30);
    expect(windowed).toHaveLength(0);
  });
});

describe('CreditTransactionRepository.sourceUsageForOwner', () => {
  const recent = () => new Date();

  /**
   * Pinned rather than derived from AI_USAGE_TRANSACTION_TYPES: deriving it from
   * the constant under test would make the assertion tautological, since dropping
   * a type would shrink both the seed and the expectation.
   */
  const EXPECTED_AI_USAGE_TYPES = [
    'text_generation_usage',
    'image_generation_usage',
    'image_edit_usage',
    'video_generation_usage',
    'realtime_voice_usage',
    'tool_usage',
    'completion_api_usage',
    'speech_to_text_usage',
    'text_to_speech_usage',
    'sound_effects_usage',
  ];

  it('counts every AI usage type', async () => {
    await seed(EXPECTED_AI_USAGE_TYPES.map(type => ({ type, source: 'web', credits: -10, createdAt: recent() })));

    const rows = await creditTransactionRepository.sourceUsageForOwner(ORG, CreditHolderType.Organization);

    expect(rows).toMatchObject([
      { source: 'web', requests: EXPECTED_AI_USAGE_TYPES.length, creditsSpent: EXPECTED_AI_USAGE_TYPES.length * 10 },
    ]);
  });

  it('breaks ties on source so equal-spend buckets keep a stable order', async () => {
    await seed([
      { source: 'web', credits: -50, createdAt: recent() },
      { source: 'cli', credits: -50, createdAt: recent() },
      { source: 'api', credits: -50, createdAt: recent() },
    ]);

    const rows = await creditTransactionRepository.sourceUsageForOwner(ORG, CreditHolderType.Organization);

    expect(rows.map(r => r.source)).toEqual(['api', 'cli', 'web']);
  });

  it('groups AI usage by source with spend magnitude, biggest spender first', async () => {
    await seed([
      { source: 'web', credits: -50, createdAt: recent() },
      { source: 'web', credits: -30, createdAt: recent() },
      { source: 'cli', credits: -200, createdAt: recent() },
      { type: 'image_generation_usage', source: 'agent', credits: -10, createdAt: recent() },
    ]);

    const rows = await creditTransactionRepository.sourceUsageForOwner(ORG, CreditHolderType.Organization);

    expect(rows).toMatchObject([
      { source: 'cli', requests: 1, creditsSpent: 200 },
      { source: 'web', requests: 2, creditsSpent: 80 },
      { source: 'agent', requests: 1, creditsSpent: 10 },
    ]);
  });

  it('buckets rows with no source as unclassified and pins them last despite outspending', async () => {
    await seed([
      { credits: -999, createdAt: recent() }, // predates source tracking
      { source: 'web', credits: -5, createdAt: recent() },
    ]);

    const rows = await creditTransactionRepository.sourceUsageForOwner(ORG, CreditHolderType.Organization);

    expect(rows).toMatchObject([
      { source: 'web', creditsSpent: 5 },
      { source: 'unclassified', requests: 1, creditsSpent: 999 },
    ]);
  });

  it('counts only AI usage, so the buckets sum to the ledger spend', async () => {
    await seed([
      { source: 'web', credits: -40, createdAt: recent() },
      // Non-AI rows: a top-up, a transfer out, and a dispute clawback.
      { type: 'purchase', credits: 500, createdAt: recent() },
      { type: 'transfer_credit', source: 'web', credits: -100, createdAt: recent() },
      { type: 'generic_deduct', credits: -25, createdAt: recent() },
    ]);

    const rows = await creditTransactionRepository.sourceUsageForOwner(ORG, CreditHolderType.Organization);

    expect(rows).toMatchObject([{ source: 'web', requests: 1, creditsSpent: 40 }]);
  });

  it('scopes to the owner and the trailing window', async () => {
    await seed([{ source: 'web', credits: -10, createdAt: recent() }]);
    await seed([{ ownerId: 'org-2', source: 'cli', credits: -999, createdAt: recent() }]);

    const scoped = await creditTransactionRepository.sourceUsageForOwner(ORG, CreditHolderType.Organization);
    expect(scoped).toMatchObject([{ source: 'web', creditsSpent: 10 }]);

    await CreditTransaction.collection.updateMany({}, { $set: { createdAt: new Date('2020-01-01') } });
    const windowed = await creditTransactionRepository.sourceUsageForOwner(ORG, CreditHolderType.Organization, 30);
    expect(windowed).toHaveLength(0);
  });
});
