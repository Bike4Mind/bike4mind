import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { CreditTransaction, creditTransactionRepository } from './CreditTransactionModel';
import { CreditHolderType, GenericCreditDeductTransaction, GenericDeductReasons } from '@bike4mind/common';

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
    'decision_usage',
    'speech_to_text_usage',
    'text_to_speech_usage',
    'sound_effects_usage',
    'music_generation_usage',
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

describe('CreditTransactionRepository.queryAdminAdjustmentsPage', () => {
  const USER = 'user-1';
  const recent = () => new Date();
  const seedAdjustments = (rows: Array<Record<string, unknown>>) =>
    CreditTransaction.collection.insertMany(
      rows.map(r => ({
        ownerId: USER,
        ownerType: CreditHolderType.User,
        credits: 50,
        type: 'generic_add',
        reason: 'admin_adjustment',
        createdAt: day(1),
        updatedAt: day(1),
        ...r,
      }))
    );

  it('returns admin adjustments across all users, newest first, paginated', async () => {
    await seedAdjustments([
      { ownerId: 'user-a', createdAt: day(1) },
      { ownerId: 'user-b', type: 'generic_deduct', credits: -20, createdAt: day(3) },
      { ownerId: 'user-c', createdAt: day(2) },
    ]);

    const page1 = await creditTransactionRepository.queryAdminAdjustmentsPage({ limit: 2, skip: 0 });
    expect(page1.total).toBe(3);
    expect(page1.data.map(d => d.createdAt.getTime())).toEqual([day(3).getTime(), day(2).getTime()]);
    expect(page1.data.map(d => d.ownerId)).toEqual(['user-b', 'user-c']);
  });

  it('excludes non-admin generic writes and usage/org rows', async () => {
    await seedAdjustments([{ createdAt: recent() }]); // admin adjustment (kept)
    await seed([
      // OTC-style generic_add against a user, but not an admin adjustment
      {
        ownerId: USER,
        ownerType: CreditHolderType.User,
        type: 'generic_add',
        reason: 'OTC registration',
        credits: 100,
        createdAt: recent(),
      },
      // usage row
      {
        ownerId: USER,
        ownerType: CreditHolderType.User,
        type: 'text_generation_usage',
        credits: -5,
        createdAt: recent(),
      },
      // admin_adjustment but on an organization holder
      { type: 'generic_deduct', reason: 'admin_adjustment', credits: -10, createdAt: recent() },
    ]);

    const { data, total } = await creditTransactionRepository.queryAdminAdjustmentsPage({ limit: 50, skip: 0 });
    expect(total).toBe(1);
    expect(data[0].ownerType).toBe(CreditHolderType.User);
    expect(data[0].reason).toBe('admin_adjustment');
  });

  it('honors the trailing-day window', async () => {
    await seedAdjustments([{ createdAt: recent() }]);
    let res = await creditTransactionRepository.queryAdminAdjustmentsPage({ days: 30, limit: 50, skip: 0 });
    expect(res.total).toBe(1);

    await CreditTransaction.collection.updateMany({}, { $set: { createdAt: new Date('2020-01-01') } });
    res = await creditTransactionRepository.queryAdminAdjustmentsPage({ days: 30, limit: 50, skip: 0 });
    expect(res.total).toBe(0);
  });
});

describe('CreditTransactionRepository.dailyNetCreditsForOwner', () => {
  it('sums signed credits per UTC day since `from`, oldest first, scoped to the owner', async () => {
    await seed([
      { ownerId: 'user-1', ownerType: CreditHolderType.User, credits: 100, type: 'purchase', createdAt: day(2) },
      {
        ownerId: 'user-1',
        ownerType: CreditHolderType.User,
        credits: -30,
        createdAt: new Date(Date.UTC(2026, 0, 2, 23, 59)),
      },
      { ownerId: 'user-1', ownerType: CreditHolderType.User, credits: -5, createdAt: day(4) },
      // Before the window, another owner, and an org holder with the same id are all excluded.
      { ownerId: 'user-1', ownerType: CreditHolderType.User, credits: -999, createdAt: day(1) },
      { ownerId: 'user-2', ownerType: CreditHolderType.User, credits: -999, createdAt: day(3) },
      { ownerId: 'user-1', ownerType: CreditHolderType.Organization, credits: -999, createdAt: day(3) },
      // After the window closes: the sum must stop where the balance snapshot was taken.
      { ownerId: 'user-1', ownerType: CreditHolderType.User, credits: -999, createdAt: day(7) },
    ]);

    const rows = await creditTransactionRepository.dailyNetCreditsForOwner(
      'user-1',
      CreditHolderType.User,
      day(2),
      day(6)
    );

    expect(rows).toEqual([
      { day: '2026-01-02', netCredits: 70 },
      { day: '2026-01-04', netCredits: -5 },
    ]);
  });
});

describe('CreditTransactionRepository.findAdminAdjustmentsForUser', () => {
  it('returns only that user admin adjustments since `from`, newest first, capped at limit', async () => {
    const adjustment = { ownerId: 'user-1', ownerType: CreditHolderType.User, reason: 'admin_adjustment' };
    await seed([
      { ...adjustment, type: 'generic_add', credits: 50, createdAt: day(3) },
      { ...adjustment, type: 'generic_deduct', credits: -20, createdAt: day(5) },
      { ...adjustment, type: 'generic_add', credits: 10, createdAt: day(4) },
      { ...adjustment, type: 'generic_add', credits: 10, createdAt: day(1) },
      { ...adjustment, ownerId: 'user-2', type: 'generic_add', createdAt: day(5) },
      { ownerId: 'user-1', ownerType: CreditHolderType.User, type: 'generic_add', reason: 'otc', createdAt: day(5) },
      { ...adjustment, type: 'generic_add', credits: 999, createdAt: day(7) },
    ]);

    const rows = await creditTransactionRepository.findAdminAdjustmentsForUser('user-1', day(2), day(6), 2);

    expect(rows.map(row => row.credits)).toEqual([-20, 10]);
  });
});

describe('generic_deduct rows with built-in reasons', () => {
  it('read back through the per-owner ledger query and still satisfy the transaction schema', async () => {
    await seed(
      GenericDeductReasons.map((reason, i) => ({
        type: 'generic_deduct',
        reason,
        credits: -1,
        createdAt: day(i + 1),
        updatedAt: day(i + 1),
      }))
    );

    const rows = await creditTransactionRepository.findByOwnerWithFilters(ORG, CreditHolderType.Organization, {
      transactionTypes: ['generic_deduct'],
    });

    expect(rows.map(r => r.reason).sort()).toEqual([...GenericDeductReasons].sort());
    for (const row of rows) {
      const parsed = GenericCreditDeductTransaction.safeParse(row.toObject());
      expect(parsed.success, `${row.reason}: ${parsed.error?.message}`).toBe(true);
    }
  });
});

describe('admin ledger repository methods', () => {
  const USER = 'user-ledger';
  const userRow = (r: Record<string, unknown>) => seed([{ ownerId: USER, ownerType: CreditHolderType.User, ...r }]);
  const at = (hour: number) => new Date(Date.UTC(2026, 0, 10, hour));

  describe('findLedgerPage', () => {
    it('pages newest-first with an _id tiebreak and never skips or repeats rows sharing a timestamp', async () => {
      await seed(
        [1, 2, 3, 4, 5].map(i => ({
          ownerId: USER,
          ownerType: CreditHolderType.User,
          createdAt: i <= 3 ? at(12) : at(i),
        }))
      );

      const seen: string[] = [];
      let after: { createdAt: Date; id: string } | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await creditTransactionRepository.findLedgerPage(USER, CreditHolderType.User, {
          after,
          limit: 2,
        });
        if (page.length === 0) break;
        seen.push(...page.map(row => row.id));
        const last = page[page.length - 1];
        after = { createdAt: last.createdAt, id: last.id };
      }

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('filters by type and ignores other owners', async () => {
      await userRow({ type: 'purchase', createdAt: at(1) });
      await userRow({ type: 'text_generation_usage', createdAt: at(2) });
      await seed([{ ownerId: 'someone-else', ownerType: CreditHolderType.User, type: 'purchase' }]);

      const page = await creditTransactionRepository.findLedgerPage(USER, CreditHolderType.User, {
        types: ['purchase'],
        limit: 10,
      });
      expect(page.map(row => row.type)).toEqual(['purchase']);
    });
  });

  describe('sumSignedCreditsNewerThan', () => {
    it('sums only strictly newer rows with type-derived signs', async () => {
      await userRow({ type: 'text_generation_usage', credits: -5, createdAt: at(1) });
      await userRow({ type: 'purchase', credits: 100, createdAt: at(2) });
      await userRow({ type: 'text_generation_usage', credits: 7, createdAt: at(3) });
      await userRow({ type: 'generic_deduct', credits: -20, createdAt: at(4) });

      const oldest = await creditTransactionRepository.findLedgerPage(USER, CreditHolderType.User, { limit: 10 });
      const first = oldest[oldest.length - 1];
      const total = await creditTransactionRepository.sumSignedCreditsNewerThan(USER, CreditHolderType.User, {
        createdAt: first.createdAt,
        id: first.id,
      });
      // purchase +100, usage -7, deduct -20; the row at the position itself is excluded.
      expect(total).toBe(73);
    });

    it('returns 0 when nothing is newer', async () => {
      await userRow({ type: 'purchase', credits: 10, createdAt: at(1) });
      const [newest] = await creditTransactionRepository.findLedgerPage(USER, CreditHolderType.User, { limit: 1 });
      expect(
        await creditTransactionRepository.sumSignedCreditsNewerThan(USER, CreditHolderType.User, {
          createdAt: newest.createdAt,
          id: newest.id,
        })
      ).toBe(0);
    });
  });

  describe('summarizeAiSpend', () => {
    const now = new Date(Date.UTC(2026, 5, 15, 12));
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

    it('splits spend across windows, picks the top model and buckets days', async () => {
      await userRow({ type: 'text_generation_usage', credits: -10, model: 'm-a', createdAt: hoursAgo(1) });
      await userRow({ type: 'completion_api_usage', credits: -30, model: 'm-b', createdAt: hoursAgo(48) });
      await userRow({ type: 'text_generation_usage', credits: -100, model: 'm-a', createdAt: hoursAgo(24 * 20) });
      await userRow({ type: 'text_generation_usage', credits: -1000, model: 'm-c', createdAt: hoursAgo(24 * 60) });
      await userRow({ type: 'purchase', credits: 500, createdAt: hoursAgo(2) });
      await userRow({ type: 'transfer_credit', credits: -999, createdAt: hoursAgo(2) });

      const summary = await creditTransactionRepository.summarizeAiSpend(USER, CreditHolderType.User, now);
      expect(summary.spent).toEqual({ last24h: 10, last7d: 40, last30d: 140 });
      expect(summary.topModel30d).toEqual({ model: 'm-a', credits: 110 });
      expect(summary.dailyCredits.reduce((sum, d) => sum + d.credits, 0)).toBe(1140);
      expect(summary.dailyCredits.map(d => d.day)).toEqual([...summary.dailyCredits.map(d => d.day)].sort());
    });

    it('returns zeros and a null top model when there is no usage', async () => {
      const summary = await creditTransactionRepository.summarizeAiSpend(USER, CreditHolderType.User, now);
      expect(summary).toEqual({
        spent: { last24h: 0, last7d: 0, last30d: 0 },
        topModel30d: null,
        dailyCredits: [],
      });
    });
  });

  describe('findLatestTopUp', () => {
    it('returns the newest completed purchase or subscription, skipping pending purchases', async () => {
      await userRow({ type: 'subscription', credits: 50, createdAt: at(1) });
      await userRow({ type: 'purchase', credits: 200, status: 'completed', createdAt: at(2) });
      await userRow({ type: 'purchase', credits: 900, status: 'pending', createdAt: at(3) });
      await userRow({ type: 'generic_add', credits: 1, createdAt: at(4) });

      const top = await creditTransactionRepository.findLatestTopUp(USER, CreditHolderType.User);
      expect(top?.type).toBe('purchase');
      expect(top?.credits).toBe(200);
    });

    it('returns null when the owner never topped up', async () => {
      expect(await creditTransactionRepository.findLatestTopUp(USER, CreditHolderType.User)).toBeNull();
    });
  });
});
