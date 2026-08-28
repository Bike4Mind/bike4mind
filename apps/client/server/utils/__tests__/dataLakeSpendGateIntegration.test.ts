import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import {
  Cache,
  DataLakeModel,
  FabFile,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  organizationRepository,
  userRepository,
  usageEventRepository,
  dataLakeSpendNotificationRepository,
  cacheRepository,
  User,
  UsageEvent,
  DataLakeSpendNotificationModel,
} from '@bike4mind/database';
import { dataLakeService, recordOperationalUsage } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Only the admin-settings SOURCE is stubbed (an external config leaf, not the seam under
// test) - resolveSpendLevers' own parsing/clamping still runs for real against these values.
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return { ...actual, getSettingsByNames: vi.fn() };
});
const mockedGetSettings = vi.mocked(getSettingsByNames);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await Promise.all([
    DataLakeModel.syncIndexes(),
    FabFile.syncIndexes(),
    UsageEvent.syncIndexes(),
    DataLakeSpendNotificationModel.syncIndexes(),
    User.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all([
    DataLakeModel.deleteMany({}),
    FabFile.deleteMany({}),
    UsageEvent.deleteMany({}),
    DataLakeSpendNotificationModel.deleteMany({}),
    User.deleteMany({}),
  ]);
});

const PER_LAKE_BUDGET_USD = 0.0001; // 100 microUSD - tiny, so one small embed crosses 80%.

describe('cross-milestone seam: ingest -> ledger -> notification claim -> mailer', () => {
  it('crossing 80% of the per-lake budget writes a UsageEvent row, claims one notification, and emails the owner', async () => {
    const owner = await User.create({ username: 'lake-owner', name: 'Lake Owner', email: 'owner@example.com' });
    const lake = await dataLakeRepository.create({
      name: 'spend-integration-lake',
      slug: 'spend-integration-lake',
      fileTagPrefix: 'spend-integration-lake:',
      datalakeTag: 'datalake:spend-integration-lake',
      createdByUserId: String(owner._id),
      status: 'active',
    } as never);

    mockedGetSettings.mockResolvedValue({
      dataLakeEmbeddingSpendEnabled: 'true',
      dataLakeEmbeddingBudgetPerRunUsd: '5',
      dataLakeEmbeddingBudgetPerLakeUsd: String(PER_LAKE_BUDGET_USD),
      dataLakeEmbeddingBudgetPerPeriodUsd: '50',
      dataLakeEmbeddingBudgetPeriodHours: '24',
      dataLakeEmbeddingMaxCallsPerMinute: '120',
      dataLakeEmbeddingMaxTokensPerMinute: '600000',
      dataLakeVectorizeChunkBatchSize: '50',
    });

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const notify = (event: Parameters<typeof dataLakeService.sendDataLakeSpendNotification>[0]) =>
      dataLakeService.sendDataLakeSpendNotification(event, {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          organizations: organizationRepository,
          users: userRepository,
          spendNotifications: dataLakeSpendNotificationRepository,
        },
        mailer: { sendEmail },
      });

    // 85 microUSD against a 100 microUSD budget = 85% - crosses the 80% approaching-cap threshold.
    const estimatedMicroUsd = 85;
    await dataLakeService.enforceEmbeddingSpendGate({
      estimatedMicroUsd,
      estimatedTokens: 1_000,
      dataLakeId: lake.id,
      db: {
        adminSettings: { findBySettingNames: vi.fn().mockResolvedValue([]), findAll: vi.fn().mockResolvedValue([]) },
        cache: cacheRepository,
        dataLakes: dataLakeRepository,
        dataLakeBatches: { tryAddEmbeddingSpend: vi.fn().mockResolvedValue(true) },
      },
      notify,
    });

    // Mirrors fabFileVectorize's own sequence: the gate grants, then the caller ledgers the spend.
    await recordOperationalUsage(
      {
        requestId: 'batch-1',
        user: owner as never,
        dataLakeId: lake.id,
        feature: 'embedding',
        provider: 'openai',
        model: 'text-embedding-3-small',
        inputTokens: 42,
        costUsd: estimatedMicroUsd / 1_000_000,
        bypassCreditBilling: true,
      },
      {
        db: {
          usageEvents: usageEventRepository,
          adminSettings: { findAll: vi.fn().mockResolvedValue([]), findBySettingNames: vi.fn().mockResolvedValue([]) },
        },
      }
    );

    // 1. Ledger row exists, attributed to the lake (M1).
    const ledgerRows = await UsageEvent.find({ dataLakeId: lake.id });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].costUsd).toBeCloseTo(estimatedMicroUsd / 1_000_000, 10);

    // 2. Exactly one notification claimed for this lake (M5/M6).
    const claims = await DataLakeSpendNotificationModel.find({ dataLakeId: lake.id });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: 'approaching_cap', scope: 'lake' });

    // 3. The mock mailer was invoked with the lake owner's address (M4/M5).
    expect(sendEmail).toHaveBeenCalledWith('owner@example.com', expect.anything());
  });

  it('a second crossing in the same lake-budget window is deduped - no second email', async () => {
    const owner = await User.create({ username: 'lake-owner-2', name: 'Lake Owner 2', email: 'owner2@example.com' });
    const lake = await dataLakeRepository.create({
      name: 'spend-integration-lake-2',
      slug: 'spend-integration-lake-2',
      fileTagPrefix: 'spend-integration-lake-2:',
      datalakeTag: 'datalake:spend-integration-lake-2',
      createdByUserId: String(owner._id),
      status: 'active',
    } as never);

    mockedGetSettings.mockResolvedValue({
      dataLakeEmbeddingSpendEnabled: 'true',
      dataLakeEmbeddingBudgetPerRunUsd: '5',
      dataLakeEmbeddingBudgetPerLakeUsd: String(PER_LAKE_BUDGET_USD),
      dataLakeEmbeddingBudgetPerPeriodUsd: '50',
      dataLakeEmbeddingBudgetPeriodHours: '24',
      dataLakeEmbeddingMaxCallsPerMinute: '120',
      dataLakeEmbeddingMaxTokensPerMinute: '600000',
      dataLakeVectorizeChunkBatchSize: '50',
    });

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const notify = (event: Parameters<typeof dataLakeService.sendDataLakeSpendNotification>[0]) =>
      dataLakeService.sendDataLakeSpendNotification(event, {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          organizations: organizationRepository,
          users: userRepository,
          spendNotifications: dataLakeSpendNotificationRepository,
        },
        mailer: { sendEmail },
      });
    const gateDb = {
      adminSettings: { findBySettingNames: vi.fn().mockResolvedValue([]), findAll: vi.fn().mockResolvedValue([]) },
      cache: cacheRepository,
      dataLakes: dataLakeRepository,
      dataLakeBatches: { tryAddEmbeddingSpend: vi.fn().mockResolvedValue(true) },
    };

    await dataLakeService.enforceEmbeddingSpendGate({
      estimatedMicroUsd: 85,
      estimatedTokens: 1_000,
      dataLakeId: lake.id,
      db: gateDb,
      notify,
    });
    // Second small embed on the same lake, still within the (already-exceeded) budget window key.
    await dataLakeService
      .enforceEmbeddingSpendGate({
        estimatedMicroUsd: 1,
        estimatedTokens: 1_000,
        dataLakeId: lake.id,
        db: gateDb,
        notify,
      })
      .catch(() => {}); // may deny depending on remaining headroom; irrelevant to this assertion

    const claims = await DataLakeSpendNotificationModel.find({ dataLakeId: lake.id, kind: 'approaching_cap' });
    expect(claims).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('N racing workers crossing 80% concurrently still produce exactly one claim and one email', async () => {
    const owner = await User.create({ username: 'lake-owner-3', name: 'Lake Owner 3', email: 'owner3@example.com' });
    const lake = await dataLakeRepository.create({
      name: 'spend-integration-lake-3',
      slug: 'spend-integration-lake-3',
      fileTagPrefix: 'spend-integration-lake-3:',
      datalakeTag: 'datalake:spend-integration-lake-3',
      createdByUserId: String(owner._id),
      status: 'active',
    } as never);

    mockedGetSettings.mockResolvedValue({
      dataLakeEmbeddingSpendEnabled: 'true',
      dataLakeEmbeddingBudgetPerRunUsd: '5',
      dataLakeEmbeddingBudgetPerLakeUsd: String(PER_LAKE_BUDGET_USD),
      dataLakeEmbeddingBudgetPerPeriodUsd: '50',
      dataLakeEmbeddingBudgetPeriodHours: '24',
      dataLakeEmbeddingMaxCallsPerMinute: '120',
      dataLakeEmbeddingMaxTokensPerMinute: '600000',
      dataLakeVectorizeChunkBatchSize: '50',
    });

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const notify = (event: Parameters<typeof dataLakeService.sendDataLakeSpendNotification>[0]) =>
      dataLakeService.sendDataLakeSpendNotification(event, {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          organizations: organizationRepository,
          users: userRepository,
          spendNotifications: dataLakeSpendNotificationRepository,
        },
        mailer: { sendEmail },
        // Generous on purpose: 8 concurrent real-Mongo round trips can genuinely exceed the
        // production default under test-harness load - this test is proving claim dedup under
        // concurrency, not the send-timeout's own re-arm behavior (covered separately).
        sendTimeoutMs: 10_000,
      });
    const gateDb = {
      adminSettings: { findBySettingNames: vi.fn().mockResolvedValue([]), findAll: vi.fn().mockResolvedValue([]) },
      cache: cacheRepository,
      dataLakes: dataLakeRepository,
      dataLakeBatches: { tryAddEmbeddingSpend: vi.fn().mockResolvedValue(true) },
    };

    // 8 concurrent workers, each reserving 12 microUSD (96 total, still under the 100 budget -
    // deliberately NOT exhausting it, or a later worker's denial would fire its own separate,
    // equally-legitimate budget_exhausted notification and confound this test's assertion).
    // The crossing (>=80) happens strictly between the 6th and 7th grant (72 -> 84), somewhere
    // in the middle of the race, not deterministically on a single call - this exercises the
    // atomic claim's real concurrency guard rather than a single sequential crossing.
    const WORKER_COUNT = 8;
    await Promise.all(
      Array.from({ length: WORKER_COUNT }, () =>
        dataLakeService.enforceEmbeddingSpendGate({
          estimatedMicroUsd: 12,
          estimatedTokens: 1_000,
          dataLakeId: lake.id,
          db: gateDb,
          notify,
        })
      )
    );

    const claims = await DataLakeSpendNotificationModel.find({ dataLakeId: lake.id });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: 'approaching_cap', scope: 'lake' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('acknowledged: SQS redelivery can double-write the ledger row (mirrors the lake meter double-count, documented not fixed)', async () => {
    const owner = await User.create({ username: 'lake-owner-4', name: 'Lake Owner 4', email: 'owner4@example.com' });
    const lake = await dataLakeRepository.create({
      name: 'spend-integration-lake-4',
      slug: 'spend-integration-lake-4',
      fileTagPrefix: 'spend-integration-lake-4:',
      datalakeTag: 'datalake:spend-integration-lake-4',
      createdByUserId: String(owner._id),
      status: 'active',
    } as never);

    // Two redeliveries of the "same" ingestion embed both call recordOperationalUsage - there is
    // no idempotency key on the ledger write, matching fabFileVectorize's own acknowledged
    // double-count on the lake meter for the identical scenario (cache write races the freeze).
    const recordOnce = () =>
      recordOperationalUsage(
        {
          requestId: 'batch-redelivery',
          user: owner as never,
          dataLakeId: lake.id,
          feature: 'embedding',
          provider: 'openai',
          model: 'text-embedding-3-small',
          inputTokens: 10,
          costUsd: 0.00001,
          bypassCreditBilling: true,
        },
        {
          db: {
            usageEvents: usageEventRepository,
            adminSettings: {
              findAll: vi.fn().mockResolvedValue([]),
              findBySettingNames: vi.fn().mockResolvedValue([]),
            },
          },
        }
      );

    await recordOnce();
    await recordOnce();

    const ledgerRows = await UsageEvent.find({ dataLakeId: lake.id });
    expect(ledgerRows).toHaveLength(2);
  });

  it('the ledger and the lake meter agree on a single real call, then drift TOGETHER (not independently) on a redelivery (N8)', async () => {
    const owner = await User.create({ username: 'lake-owner-5', name: 'Lake Owner 5', email: 'owner5@example.com' });
    const lake = await dataLakeRepository.create({
      name: 'spend-integration-lake-5',
      slug: 'spend-integration-lake-5',
      fileTagPrefix: 'spend-integration-lake-5:',
      datalakeTag: 'datalake:spend-integration-lake-5',
      createdByUserId: String(owner._id),
      status: 'active',
    } as never);

    mockedGetSettings.mockResolvedValue({
      dataLakeEmbeddingSpendEnabled: 'true',
      dataLakeEmbeddingBudgetPerRunUsd: '5',
      dataLakeEmbeddingBudgetPerLakeUsd: '5',
      dataLakeEmbeddingBudgetPerPeriodUsd: '50',
      dataLakeEmbeddingBudgetPeriodHours: '24',
      dataLakeEmbeddingMaxCallsPerMinute: '120',
      dataLakeEmbeddingMaxTokensPerMinute: '600000',
      dataLakeVectorizeChunkBatchSize: '50',
    });

    const gateDb = {
      adminSettings: { findBySettingNames: vi.fn().mockResolvedValue([]), findAll: vi.fn().mockResolvedValue([]) },
      cache: cacheRepository,
      dataLakes: dataLakeRepository,
      dataLakeBatches: { tryAddEmbeddingSpend: vi.fn().mockResolvedValue(true) },
    };
    const estimatedMicroUsd = 40;

    // Mirrors fabFileVectorize's actual sequence: gate reserves against the meter, THEN the
    // caller ledgers the same amount - two separate writes to two separate collections, no
    // shared transaction.
    const ingestOnce = async () => {
      await dataLakeService.enforceEmbeddingSpendGate({
        estimatedMicroUsd,
        estimatedTokens: 7,
        dataLakeId: lake.id,
        db: gateDb,
      });
      await recordOperationalUsage(
        {
          requestId: 'batch-agreement',
          user: owner as never,
          dataLakeId: lake.id,
          feature: 'embedding',
          provider: 'openai',
          model: 'text-embedding-3-small',
          inputTokens: 7,
          costUsd: estimatedMicroUsd / 1_000_000,
          bypassCreditBilling: true,
        },
        {
          db: {
            usageEvents: usageEventRepository,
            adminSettings: {
              findAll: vi.fn().mockResolvedValue([]),
              findBySettingNames: vi.fn().mockResolvedValue([]),
            },
          },
        }
      );
    };

    await ingestOnce();

    const lakeAfterOne = await DataLakeModel.findById(lake.id);
    const ledgerAfterOne = await UsageEvent.find({ dataLakeId: lake.id });
    // Agreement on a single real call: the meter's reservation and the ledger's recorded cost
    // are the exact same amount, since both derive from the same estimatedMicroUsd.
    expect(lakeAfterOne?.embeddingSpendMicroUsd).toBe(estimatedMicroUsd);
    expect(ledgerAfterOne).toHaveLength(1);
    expect(ledgerAfterOne[0].costUsd).toBeCloseTo(estimatedMicroUsd / 1_000_000, 10);
    expect(ledgerAfterOne[0].inputTokens).toBe(7);

    // A redelivery of the SAME logical message repeats the whole sequence - no idempotency key
    // on either write. Both sides double, TOGETHER, rather than one moving and not the other -
    // the accepted drift is that they double in lockstep, not that they diverge from each other.
    await ingestOnce();

    const lakeAfterTwo = await DataLakeModel.findById(lake.id);
    const ledgerAfterTwo = await UsageEvent.find({ dataLakeId: lake.id });
    expect(lakeAfterTwo?.embeddingSpendMicroUsd).toBe(estimatedMicroUsd * 2);
    expect(ledgerAfterTwo).toHaveLength(2);
    expect(ledgerAfterTwo.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(
      (estimatedMicroUsd * 2) / 1_000_000,
      10
    );
  });
});

/**
 * The membership arm of the gate, against a REAL lakes collection and REAL tag documents.
 * The unit tests for resolveIngestSpendScope mock the repositories, so they prove the decision
 * table but not the query: whether an actual FabFile tag document matches an actual lake's
 * meta-tag and prefix arms is exactly the assumption that, when wrong, silently returns "not
 * lake work" and reopens the bypass this change closes.
 */
describe('resolveIngestSpendScope over real lake membership', () => {
  const seedLake = async (ownerId: string, slug: string) =>
    dataLakeRepository.create({
      name: slug,
      slug,
      fileTagPrefix: `${slug}:`,
      datalakeTag: `datalake:${slug}`,
      createdByUserId: ownerId,
      status: 'active',
    } as never);

  const scopeFor = (file: { id: string; userId: string; tags?: { name: string }[]; batchId?: string }) =>
    dataLakeService.resolveIngestSpendScope(file, {
      dataLakeBatches: { findById: vi.fn().mockResolvedValue(null) },
      dataLakes: dataLakeRepository,
    });

  it('resolves a member joined by the lake meta-tag, with no batchId', async () => {
    const owner = await User.create({ username: 'tagged-owner', name: 'Tagged', email: 'tagged@example.com' });
    const lake = await seedLake(String(owner._id), 'membership-meta-lake');
    const file = await FabFile.create({
      userId: String(owner._id),
      fileName: 'joined.txt',
      type: 'FILE',
      filePath: 'joined.txt',
      tags: [{ name: 'datalake:membership-meta-lake', strength: 1 }],
    });

    const scope = await scopeFor({ id: String(file._id), userId: String(owner._id), tags: file.tags });

    expect(scope).toEqual({ dataLakeId: lake.id });
  });

  it('resolves a member joined only by the owner-anchored prefix arm', async () => {
    const owner = await User.create({ username: 'prefix-owner', name: 'Prefix', email: 'prefix@example.com' });
    const lake = await seedLake(String(owner._id), 'membership-prefix-lake');
    const file = await FabFile.create({
      userId: String(owner._id),
      fileName: 'prefixed.txt',
      type: 'FILE',
      filePath: 'prefixed.txt',
      tags: [{ name: 'membership-prefix-lake:contracts', strength: 1 }],
    });

    const scope = await scopeFor({ id: String(file._id), userId: String(owner._id), tags: file.tags });

    expect(scope).toEqual({ dataLakeId: lake.id });
  });

  it('returns null for a personal file that belongs to no lake, so ordinary uploads are unaffected', async () => {
    const owner = await User.create({ username: 'solo-owner', name: 'Solo', email: 'solo@example.com' });
    await seedLake(String(owner._id), 'membership-other-lake');
    const file = await FabFile.create({
      userId: String(owner._id),
      fileName: 'personal.txt',
      type: 'FILE',
      filePath: 'personal.txt',
      tags: [{ name: 'notes', strength: 1 }],
    });

    const scope = await scopeFor({ id: String(file._id), userId: String(owner._id), tags: file.tags });

    expect(scope).toBeNull();
  });
});

/** The TPM window against the REAL fixed-window counter, not a mocked cache. */
describe('token-per-minute window over the real cache counter', () => {
  // The throughput windows are ONE platform-wide counter each, deliberately - every data-lake
  // embed shares them. That makes them cross-test state: earlier tests in this file spend tokens
  // against the same key, so the window has to be cleared or this describe reads their spend as
  // its own. (Discovering that here is the design working as documented, not a leak.)
  beforeEach(async () => {
    await Cache.deleteMany({ key: { $regex: '^dataLakeEmbeddingSpend:' } });
  });

  const levers = (maxTokensPerMinute: string) => ({
    dataLakeEmbeddingSpendEnabled: 'true',
    dataLakeEmbeddingBudgetPerRunUsd: '5',
    dataLakeEmbeddingBudgetPerLakeUsd: '100',
    dataLakeEmbeddingBudgetPerPeriodUsd: '50',
    dataLakeEmbeddingBudgetPeriodHours: '24',
    dataLakeEmbeddingMaxCallsPerMinute: '120',
    dataLakeEmbeddingMaxTokensPerMinute: maxTokensPerMinute,
    dataLakeVectorizeChunkBatchSize: '50',
  });

  it('grants a call that fits the window and denies the next one as retryable', async () => {
    const owner = await User.create({ username: 'tpm-owner', name: 'TPM', email: 'tpm@example.com' });
    const lake = await dataLakeRepository.create({
      name: 'tpm-lake',
      slug: 'tpm-lake',
      fileTagPrefix: 'tpm-lake:',
      datalakeTag: 'datalake:tpm-lake',
      createdByUserId: String(owner._id),
      status: 'active',
    } as never);
    mockedGetSettings.mockResolvedValue(levers('1000') as never);

    const gateDb = {
      adminSettings: { findBySettingNames: vi.fn().mockResolvedValue([]), findAll: vi.fn().mockResolvedValue([]) },
      cache: cacheRepository,
      dataLakes: dataLakeRepository,
      dataLakeBatches: { tryAddEmbeddingSpend: vi.fn().mockResolvedValue(true) },
    };
    const call = (estimatedTokens: number) =>
      dataLakeService.enforceEmbeddingSpendGate({
        estimatedMicroUsd: 1,
        estimatedTokens,
        dataLakeId: lake.id,
        db: gateDb,
        // No real sleeping: the point is the deny, and the wait budget is exercised in unit tests.
        sleep: vi.fn().mockResolvedValue(undefined),
      });

    await expect(call(600)).resolves.toBeUndefined();

    // 600 + 600 > 1000, so the window has no room. Retryable: it drains on its own.
    let denial: unknown;
    await call(600).catch(err => (denial = err));
    expect(denial).toBeInstanceOf(dataLakeService.EmbeddingSpendDeniedError);
    expect((denial as { retryable: boolean }).retryable).toBe(true);
    expect((denial as Error).message).toMatch(/token rate limit/);
  });

  it('denies a single call larger than the whole window as TERMINAL, since redelivery cannot help', async () => {
    const owner = await User.create({ username: 'big-owner', name: 'Big', email: 'big@example.com' });
    const lake = await dataLakeRepository.create({
      name: 'big-call-lake',
      slug: 'big-call-lake',
      fileTagPrefix: 'big-call-lake:',
      datalakeTag: 'datalake:big-call-lake',
      createdByUserId: String(owner._id),
      status: 'active',
    } as never);
    mockedGetSettings.mockResolvedValue(levers('1000') as never);

    let denial: unknown;
    await dataLakeService
      .enforceEmbeddingSpendGate({
        estimatedMicroUsd: 1,
        estimatedTokens: 5_000,
        dataLakeId: lake.id,
        db: {
          adminSettings: { findBySettingNames: vi.fn().mockResolvedValue([]), findAll: vi.fn().mockResolvedValue([]) },
          cache: cacheRepository,
          dataLakes: dataLakeRepository,
          dataLakeBatches: { tryAddEmbeddingSpend: vi.fn().mockResolvedValue(true) },
        },
        sleep: vi.fn().mockResolvedValue(undefined),
      })
      .catch(err => (denial = err));

    expect((denial as { retryable: boolean }).retryable).toBe(false);
    expect((denial as Error).message).toMatch(/can never fit/);
  });
});
