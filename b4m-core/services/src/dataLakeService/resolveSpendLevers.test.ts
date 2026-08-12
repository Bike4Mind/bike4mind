import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATA_LAKE_EMBEDDING_BUDGET_PER_LAKE_USD_DEFAULT,
  DATA_LAKE_EMBEDDING_BUDGET_PER_PERIOD_USD_DEFAULT,
  DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_DEFAULT,
  DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_MAX,
  DATA_LAKE_EMBEDDING_BUDGET_PERIOD_HOURS_DEFAULT,
  DATA_LAKE_EMBEDDING_MAX_CALLS_PER_MINUTE_DEFAULT,
  DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_DEFAULT,
} from '@bike4mind/common';
import { MICRO_USD_PER_USD, resolveSpendLevers, SpendLeverResolutionError } from './resolveSpendLevers';
import { getSettingsByNames } from '@bike4mind/utils';

vi.mock('@bike4mind/utils', () => ({
  getSettingsByNames: vi.fn(),
}));

const mockedGetSettings = vi.mocked(getSettingsByNames);

// The resolver reads settings through the mocked accessor, so the repo itself is never hit.
const db = { adminSettings: { findBySettingNames: vi.fn(), findAll: vi.fn() } };

/** All levers absent unless overridden - the "fresh install" baseline. */
const settings = (overrides: Record<string, string | null> = {}): Record<string, string | null> => ({
  dataLakeEmbeddingSpendEnabled: null,
  dataLakeEmbeddingBudgetPerRunUsd: null,
  dataLakeEmbeddingBudgetPerLakeUsd: null,
  dataLakeEmbeddingBudgetPerPeriodUsd: null,
  dataLakeEmbeddingBudgetPeriodHours: null,
  dataLakeEmbeddingMaxCallsPerMinute: null,
  dataLakeVectorizeChunkBatchSize: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSpendLevers', () => {
  it('falls back to the coded defaults only when settings are absent', async () => {
    mockedGetSettings.mockResolvedValue(settings());
    const levers = await resolveSpendLevers(db);
    expect(levers).toEqual({
      spendEnabled: true,
      perRunBudgetMicroUsd: DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_DEFAULT * MICRO_USD_PER_USD,
      perLakeBudgetMicroUsd: DATA_LAKE_EMBEDDING_BUDGET_PER_LAKE_USD_DEFAULT * MICRO_USD_PER_USD,
      perPeriodBudgetMicroUsd: DATA_LAKE_EMBEDDING_BUDGET_PER_PERIOD_USD_DEFAULT * MICRO_USD_PER_USD,
      periodHours: DATA_LAKE_EMBEDDING_BUDGET_PERIOD_HOURS_DEFAULT,
      maxCallsPerMinute: DATA_LAKE_EMBEDDING_MAX_CALLS_PER_MINUTE_DEFAULT,
      vectorizeChunkBatchSize: DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_DEFAULT,
    });
  });

  it('treats an empty string like absent (cleared setting reverts to the default)', async () => {
    mockedGetSettings.mockResolvedValue(settings({ dataLakeEmbeddingBudgetPerRunUsd: '' }));
    const levers = await resolveSpendLevers(db);
    expect(levers.perRunBudgetMicroUsd).toBe(DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_DEFAULT * MICRO_USD_PER_USD);
  });

  // The anti-trap test: resolveSearchBudgets would substitute the default here.
  it('accepts 0 as a valid STOP value on every spend lever, never substituting the default', async () => {
    mockedGetSettings.mockResolvedValue(
      settings({
        dataLakeEmbeddingBudgetPerRunUsd: '0',
        dataLakeEmbeddingBudgetPerLakeUsd: '0',
        dataLakeEmbeddingBudgetPerPeriodUsd: '0',
        dataLakeEmbeddingMaxCallsPerMinute: '0',
      })
    );
    const levers = await resolveSpendLevers(db);
    expect(levers.perRunBudgetMicroUsd).toBe(0);
    expect(levers.perLakeBudgetMicroUsd).toBe(0);
    expect(levers.perPeriodBudgetMicroUsd).toBe(0);
    expect(levers.maxCallsPerMinute).toBe(0);
  });

  it('converts fractional USD budgets to integer micro-USD without losing sub-cent amounts', async () => {
    mockedGetSettings.mockResolvedValue(settings({ dataLakeEmbeddingBudgetPerRunUsd: '0.01' }));
    const levers = await resolveSpendLevers(db);
    expect(levers.perRunBudgetMicroUsd).toBe(10_000);
  });

  it.each([
    ['negative budget', { dataLakeEmbeddingBudgetPerRunUsd: '-1' }],
    ['unparseable budget', { dataLakeEmbeddingBudgetPerLakeUsd: 'lots' }],
    ['Infinity budget', { dataLakeEmbeddingBudgetPerPeriodUsd: 'Infinity' }],
    ['negative rate limit', { dataLakeEmbeddingMaxCallsPerMinute: '-5' }],
    ['fractional rate limit', { dataLakeEmbeddingMaxCallsPerMinute: '1.5' }],
    ['zero period', { dataLakeEmbeddingBudgetPeriodHours: '0' }],
    ['zero batch size', { dataLakeVectorizeChunkBatchSize: '0' }],
    ['garbage boolean', { dataLakeEmbeddingSpendEnabled: 'yes' }],
  ])('halts (never resumes at a default) on a set-but-unusable value: %s', async (_name, overrides) => {
    mockedGetSettings.mockResolvedValue(settings(overrides));
    await expect(resolveSpendLevers(db)).rejects.toThrow(SpendLeverResolutionError);
  });

  it('fails CLOSED on a settings read outage, unlike the scan-budget resolver', async () => {
    mockedGetSettings.mockRejectedValue(new Error('mongo down'));
    await expect(resolveSpendLevers(db)).rejects.toThrow(SpendLeverResolutionError);
  });

  it('clamps a value above the hard rail instead of trusting it', async () => {
    const logger = { warn: vi.fn() };
    mockedGetSettings.mockResolvedValue(settings({ dataLakeEmbeddingBudgetPerRunUsd: '999999' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const levers = await resolveSpendLevers(db, logger as any);
    expect(levers.perRunBudgetMicroUsd).toBe(DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_MAX * MICRO_USD_PER_USD);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('parses the boolean switch case-insensitively', async () => {
    mockedGetSettings.mockResolvedValue(settings({ dataLakeEmbeddingSpendEnabled: 'False' }));
    const levers = await resolveSpendLevers(db);
    expect(levers.spendEnabled).toBe(false);
  });
});
