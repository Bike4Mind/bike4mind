import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../../../packages/database/src/__test__/createMongoServer';
import {
  DataLakeModel,
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

    await dataLakeService.enforceEmbeddingSpendGate({ estimatedMicroUsd: 85, dataLakeId: lake.id, db: gateDb, notify });
    // Second small embed on the same lake, still within the (already-exceeded) budget window key.
    await dataLakeService
      .enforceEmbeddingSpendGate({ estimatedMicroUsd: 1, dataLakeId: lake.id, db: gateDb, notify })
      .catch(() => {}); // may deny depending on remaining headroom; irrelevant to this assertion

    const claims = await DataLakeSpendNotificationModel.find({ dataLakeId: lake.id, kind: 'approaching_cap' });
    expect(claims).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
