import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  DATA_LAKE_EMBEDDING_BUDGET_PER_LAKE_USD_DEFAULT,
  DATA_LAKE_EMBEDDING_BUDGET_PER_PERIOD_USD_DEFAULT,
  DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_DEFAULT,
  DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_MAX,
  DATA_LAKE_EMBEDDING_BUDGET_PERIOD_HOURS_DEFAULT,
  DATA_LAKE_EMBEDDING_MAX_CALLS_PER_MINUTE_DEFAULT,
  DATA_LAKE_EMBEDDING_TIER_MULTIPLIER_INDIVIDUAL_DEFAULT,
  DATA_LAKE_EMBEDDING_TIER_MULTIPLIER_MAX,
  DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_DEFAULT,
} from '@bike4mind/common';
import {
  MICRO_USD_PER_USD,
  pickTierMultiplier,
  resolveSpendLevers,
  SpendLeverResolutionError,
} from './resolveSpendLevers';
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
  dataLakeEmbeddingTierMultiplierIndividual: null,
  dataLakeEmbeddingTierMultiplierOrganization: null,
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
      // No owner passed, so the more restrictive tier applies - which is the individual one
      // while the individual default is the smaller of the two.
      tierMultiplier: DATA_LAKE_EMBEDDING_TIER_MULTIPLIER_INDIVIDUAL_DEFAULT,
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
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds the hard rail'));
  });

  // Regression: the admin panel stores typed values, so a 0 budget arrives as the NUMBER 0
  // and the off switch as the BOOLEAN false - not strings. Both must keep their meaning.
  it('honors a stored numeric 0 and boolean false, not just their string forms', async () => {
    mockedGetSettings.mockResolvedValue(
      settings({
        dataLakeEmbeddingBudgetPerRunUsd: 0 as unknown as string,
        dataLakeEmbeddingSpendEnabled: false as unknown as string,
      })
    );
    const levers = await resolveSpendLevers(db);
    expect(levers.perRunBudgetMicroUsd).toBe(0);
    expect(levers.spendEnabled).toBe(false);
  });

  it('parses the boolean switch case-insensitively', async () => {
    mockedGetSettings.mockResolvedValue(settings({ dataLakeEmbeddingSpendEnabled: 'False' }));
    const levers = await resolveSpendLevers(db);
    expect(levers.spendEnabled).toBe(false);
  });
});

// The tier is what makes an individual-owned and an organization-owned lake different economic
// cases (#1675). It is a lever pair, so these tests pin that the RATIO is what moves - never a
// number baked into the resolver.
describe('resolveSpendLevers cost tiers', () => {
  const tiered = (individual: string, organization: string) =>
    settings({
      dataLakeEmbeddingTierMultiplierIndividual: individual,
      dataLakeEmbeddingTierMultiplierOrganization: organization,
    });

  it('scales only the per-resource budgets, leaving the platform-wide meters untiered', async () => {
    mockedGetSettings.mockResolvedValue(tiered('1', '3'));
    const levers = await resolveSpendLevers(db, undefined, CreditHolderType.Organization);
    expect(levers.perRunBudgetMicroUsd).toBe(DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_DEFAULT * 3 * MICRO_USD_PER_USD);
    expect(levers.perLakeBudgetMicroUsd).toBe(DATA_LAKE_EMBEDDING_BUDGET_PER_LAKE_USD_DEFAULT * 3 * MICRO_USD_PER_USD);
    // One shared window across the whole platform - it has no owner to tier by.
    expect(levers.perPeriodBudgetMicroUsd).toBe(DATA_LAKE_EMBEDDING_BUDGET_PER_PERIOD_USD_DEFAULT * MICRO_USD_PER_USD);
    expect(levers.maxCallsPerMinute).toBe(DATA_LAKE_EMBEDDING_MAX_CALLS_PER_MINUTE_DEFAULT);
  });

  it('gives an individual-owned lake its own tier, not the organization one', async () => {
    mockedGetSettings.mockResolvedValue(tiered('2', '10'));
    const levers = await resolveSpendLevers(db, undefined, CreditHolderType.User);
    expect(levers.tierMultiplier).toBe(2);
    expect(levers.perRunBudgetMicroUsd).toBe(DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_DEFAULT * 2 * MICRO_USD_PER_USD);
  });

  // The tier must be a ratio an operator tunes, so it has to apply to the coded defaults too -
  // otherwise it would do nothing until someone also set an explicit budget.
  it('tiers the coded default budget, not only an explicitly-set one', async () => {
    mockedGetSettings.mockResolvedValue(tiered('1', '4'));
    const levers = await resolveSpendLevers(db, undefined, CreditHolderType.Organization);
    expect(levers.perLakeBudgetMicroUsd).toBe(DATA_LAKE_EMBEDDING_BUDGET_PER_LAKE_USD_DEFAULT * 4 * MICRO_USD_PER_USD);
  });

  it('treats a 0 multiplier as a valid STOP for that tier alone', async () => {
    mockedGetSettings.mockResolvedValue(tiered('0', '5'));
    const individual = await resolveSpendLevers(db, undefined, CreditHolderType.User);
    expect(individual.perRunBudgetMicroUsd).toBe(0);
    expect(individual.perLakeBudgetMicroUsd).toBe(0);

    mockedGetSettings.mockResolvedValue(tiered('0', '5'));
    const organization = await resolveSpendLevers(db, undefined, CreditHolderType.Organization);
    expect(organization.perRunBudgetMicroUsd).toBeGreaterThan(0);
  });

  it('holds the effective budget to the same hard rail a generous tier tries to exceed', async () => {
    const logger = { warn: vi.fn() };
    // $20 x50 = $1000, well past the $500 per-run rail.
    mockedGetSettings.mockResolvedValue({
      ...tiered('1', '50'),
      dataLakeEmbeddingBudgetPerRunUsd: '20',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const levers = await resolveSpendLevers(db, logger as any, CreditHolderType.Organization);
    expect(levers.perRunBudgetMicroUsd).toBe(DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_MAX * MICRO_USD_PER_USD);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds the hard rail'));
  });

  it('clamps the multiplier itself to its own rail', async () => {
    mockedGetSettings.mockResolvedValue(tiered('1', '99999'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const levers = await resolveSpendLevers(db, { warn: vi.fn() } as any, CreditHolderType.Organization);
    expect(levers.tierMultiplier).toBe(DATA_LAKE_EMBEDDING_TIER_MULTIPLIER_MAX);
  });

  it.each([
    ['negative individual multiplier', { dataLakeEmbeddingTierMultiplierIndividual: '-1' }],
    ['unparseable organization multiplier', { dataLakeEmbeddingTierMultiplierOrganization: 'double' }],
  ])('halts on a set-but-unusable multiplier: %s', async (_name, overrides) => {
    mockedGetSettings.mockResolvedValue(settings(overrides));
    await expect(resolveSpendLevers(db, undefined, CreditHolderType.User)).rejects.toThrow(SpendLeverResolutionError);
  });

  // Both tiers are parsed regardless of which one is in use, so a typo cannot lie dormant in the
  // tier nobody is currently on and surface the day a lake changes hands.
  it('halts on a broken multiplier for the tier this caller is NOT on', async () => {
    mockedGetSettings.mockResolvedValue(settings({ dataLakeEmbeddingTierMultiplierOrganization: 'lots' }));
    await expect(resolveSpendLevers(db, undefined, CreditHolderType.User)).rejects.toThrow(SpendLeverResolutionError);
  });

  it('accepts a fractional multiplier (a tier is a ratio, not a count)', async () => {
    mockedGetSettings.mockResolvedValue(tiered('0.5', '5'));
    const levers = await resolveSpendLevers(db, undefined, CreditHolderType.User);
    expect(levers.perRunBudgetMicroUsd).toBe(DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_DEFAULT * 0.5 * MICRO_USD_PER_USD);
  });
});

describe('pickTierMultiplier', () => {
  it('maps each owner type to its own configured tier', () => {
    expect(pickTierMultiplier(CreditHolderType.User, 2, 7)).toBe(2);
    expect(pickTierMultiplier(CreditHolderType.Organization, 2, 7)).toBe(7);
  });

  // A money gate must not resolve unknown ownership in the spender's favour, and "unknown" is not
  // a synonym for "individual" - the more restrictive tier is whichever one is actually smaller.
  it.each([
    ['organization tier is smaller', 9, 3, 3],
    ['individual tier is smaller', 1, 5, 1],
    ['tiers are equal', 4, 4, 4],
  ])('applies the more restrictive tier when the owner is unknown (%s)', (_name, individual, org, expected) => {
    expect(pickTierMultiplier(undefined, individual, org)).toBe(expected);
  });
});
