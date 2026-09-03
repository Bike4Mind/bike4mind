import {
  CreditHolderType,
  DATA_LAKE_EMBEDDING_BUDGET_PER_LAKE_USD_DEFAULT,
  DATA_LAKE_EMBEDDING_BUDGET_PER_LAKE_USD_MAX,
  DATA_LAKE_EMBEDDING_BUDGET_PER_PERIOD_USD_DEFAULT,
  DATA_LAKE_EMBEDDING_BUDGET_PER_PERIOD_USD_MAX,
  DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_DEFAULT,
  DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_MAX,
  DATA_LAKE_EMBEDDING_BUDGET_PERIOD_HOURS_DEFAULT,
  DATA_LAKE_EMBEDDING_BUDGET_PERIOD_HOURS_MAX,
  DATA_LAKE_EMBEDDING_MAX_CALLS_PER_MINUTE_DEFAULT,
  DATA_LAKE_EMBEDDING_MAX_CALLS_PER_MINUTE_MAX,
  DATA_LAKE_EMBEDDING_MAX_TOKENS_PER_MINUTE_DEFAULT,
  DATA_LAKE_EMBEDDING_MAX_TOKENS_PER_MINUTE_MAX,
  DATA_LAKE_EMBEDDING_TIER_MULTIPLIER_INDIVIDUAL_DEFAULT,
  DATA_LAKE_EMBEDDING_TIER_MULTIPLIER_MAX,
  DATA_LAKE_EMBEDDING_TIER_MULTIPLIER_ORGANIZATION_DEFAULT,
  DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_DEFAULT,
  DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_MAX,
  IAdminSettingsRepository,
  SettingKey,
  SettingOwnerType,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';

export const MICRO_USD_PER_USD = 1_000_000;

/**
 * Every spend lever this resolver reads. Exported because registering a setting is a THREE-place
 * edit - the key union, the definition, and a service-group entry - and only the first two are
 * compiler-checked (settingsMap is keyed by SettingKey). A lever missing the group entry never
 * renders in the admin panel, so it silently becomes a lever nobody can move; pinning this list
 * against the group's contents in a test is what closes that hole.
 */
export const DATA_LAKE_SPEND_LEVER_KEYS = [
  'dataLakeEmbeddingSpendEnabled',
  'dataLakeEmbeddingBudgetPerRunUsd',
  'dataLakeEmbeddingBudgetPerLakeUsd',
  'dataLakeEmbeddingBudgetPerPeriodUsd',
  'dataLakeEmbeddingBudgetPeriodHours',
  'dataLakeEmbeddingMaxCallsPerMinute',
  'dataLakeEmbeddingMaxTokensPerMinute',
  'dataLakeVectorizeChunkBatchSize',
  'dataLakeEmbeddingTierMultiplierIndividual',
  'dataLakeEmbeddingTierMultiplierOrganization',
] as const satisfies readonly SettingKey[];

/**
 * Effective spend levers for data-lake embedding work. Budgets are integer micro-USD
 * (1e-6 USD): a single embedded chunk can cost ~$0.0001, so cents-level integers would
 * meter most runs as free.
 */
export interface DataLakeSpendLevers {
  spendEnabled: boolean;
  /** Tiered by lake ownership - see {@link pickTierMultiplier}. */
  perRunBudgetMicroUsd: number;
  /** Tiered by lake ownership - see {@link pickTierMultiplier}. */
  perLakeBudgetMicroUsd: number;
  perPeriodBudgetMicroUsd: number;
  periodHours: number;
  maxCallsPerMinute: number;
  /** The TPM half of the throughput cap. Untiered and platform-wide, like maxCallsPerMinute: it
   *  protects the provider quota, which no lake owns a share of. */
  maxTokensPerMinute: number;
  vectorizeChunkBatchSize: number;
  /** The tier factor the two budgets above were scaled by. Returned so a caller can log it. */
  tierMultiplier: number;
}

/**
 * Thrown when a spend lever cannot be resolved to a value an operator demonstrably chose
 * (or the documented default). Callers on the spend path must treat this as HALT.
 */
export class SpendLeverResolutionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SpendLeverResolutionError';
  }
}

/**
 * Read the operator-configured SPEND levers for data-lake embedding work.
 *
 * This is deliberately NOT resolveSearchBudgets, and must not converge with it. That resolver
 * governs a scan budget, so it fails open: a bad or unreadable value falls back to the coded
 * default with a warning, and the worst case is under-coverage. These levers govern money on a
 * loop that rewrites customer data, so every failure mode inverts:
 *
 * - absent / empty setting  -> the coded default (the only case a default applies)
 * - 0                       -> a VALID value meaning "stop spending" (never substituted)
 * - negative / unparseable  -> SpendLeverResolutionError: halt, never resume at a default
 * - settings read outage    -> SpendLeverResolutionError: fail closed
 * - value above the rail    -> clamped to the MAX_* constant, logged ("adjustable is not unbounded")
 *
 * `ownerType` selects the cost tier (#1675) applied to the two per-resource budgets: an
 * individual-owned lake and an organization-owned one are different economic cases. Omit it for a
 * caller that reads a platform-wide lever only (the chunk handler wants the batch size); see
 * {@link pickTierMultiplier} for what an absent owner means.
 */
export async function resolveSpendLevers(
  db: { adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'> },
  logger?: Logger,
  ownerType?: SettingOwnerType
): Promise<DataLakeSpendLevers> {
  let values: Record<string, string | null>;
  try {
    values = await getSettingsByNames([...DATA_LAKE_SPEND_LEVER_KEYS], db, { logger });
  } catch (err) {
    throw new SpendLeverResolutionError('could not read data-lake spend levers; halting spend (fail closed)', {
      cause: err,
    });
  }
  // A non-object return (e.g. an incompletely-stubbed accessor) must fail closed like a read
  // error, not TypeError on the property reads below.
  if (values === null || typeof values !== 'object') {
    throw new SpendLeverResolutionError(
      `spend-lever settings read returned ${JSON.stringify(values)}; halting spend (fail closed)`
    );
  }

  // Both tiers are parsed even though only one is used, so a typo in the tier an operator is NOT
  // currently on still halts the spend path instead of lying dormant until a lake changes hands.
  const tierMultiplier = pickTierMultiplier(
    ownerType,
    nonNegativeNumberLever(
      values.dataLakeEmbeddingTierMultiplierIndividual,
      DATA_LAKE_EMBEDDING_TIER_MULTIPLIER_INDIVIDUAL_DEFAULT,
      DATA_LAKE_EMBEDDING_TIER_MULTIPLIER_MAX,
      'dataLakeEmbeddingTierMultiplierIndividual',
      logger
    ),
    nonNegativeNumberLever(
      values.dataLakeEmbeddingTierMultiplierOrganization,
      DATA_LAKE_EMBEDDING_TIER_MULTIPLIER_ORGANIZATION_DEFAULT,
      DATA_LAKE_EMBEDDING_TIER_MULTIPLIER_MAX,
      'dataLakeEmbeddingTierMultiplierOrganization',
      logger
    )
  );

  return {
    spendEnabled: booleanLever(values.dataLakeEmbeddingSpendEnabled, true, 'dataLakeEmbeddingSpendEnabled'),
    perRunBudgetMicroUsd: usdLeverToMicroUsd(
      values.dataLakeEmbeddingBudgetPerRunUsd,
      DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_DEFAULT,
      DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_MAX,
      'dataLakeEmbeddingBudgetPerRunUsd',
      logger,
      tierMultiplier
    ),
    perLakeBudgetMicroUsd: usdLeverToMicroUsd(
      values.dataLakeEmbeddingBudgetPerLakeUsd,
      DATA_LAKE_EMBEDDING_BUDGET_PER_LAKE_USD_DEFAULT,
      DATA_LAKE_EMBEDDING_BUDGET_PER_LAKE_USD_MAX,
      'dataLakeEmbeddingBudgetPerLakeUsd',
      logger,
      tierMultiplier
    ),
    perPeriodBudgetMicroUsd: usdLeverToMicroUsd(
      values.dataLakeEmbeddingBudgetPerPeriodUsd,
      DATA_LAKE_EMBEDDING_BUDGET_PER_PERIOD_USD_DEFAULT,
      DATA_LAKE_EMBEDDING_BUDGET_PER_PERIOD_USD_MAX,
      'dataLakeEmbeddingBudgetPerPeriodUsd',
      logger
    ),
    periodHours: positiveIntLever(
      values.dataLakeEmbeddingBudgetPeriodHours,
      DATA_LAKE_EMBEDDING_BUDGET_PERIOD_HOURS_DEFAULT,
      DATA_LAKE_EMBEDDING_BUDGET_PERIOD_HOURS_MAX,
      'dataLakeEmbeddingBudgetPeriodHours',
      logger
    ),
    maxCallsPerMinute: nonNegativeIntLever(
      values.dataLakeEmbeddingMaxCallsPerMinute,
      DATA_LAKE_EMBEDDING_MAX_CALLS_PER_MINUTE_DEFAULT,
      DATA_LAKE_EMBEDDING_MAX_CALLS_PER_MINUTE_MAX,
      'dataLakeEmbeddingMaxCallsPerMinute',
      logger
    ),
    maxTokensPerMinute: nonNegativeIntLever(
      values.dataLakeEmbeddingMaxTokensPerMinute,
      DATA_LAKE_EMBEDDING_MAX_TOKENS_PER_MINUTE_DEFAULT,
      DATA_LAKE_EMBEDDING_MAX_TOKENS_PER_MINUTE_MAX,
      'dataLakeEmbeddingMaxTokensPerMinute',
      logger
    ),
    vectorizeChunkBatchSize: positiveIntLever(
      values.dataLakeVectorizeChunkBatchSize,
      DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_DEFAULT,
      DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_MAX,
      'dataLakeVectorizeChunkBatchSize',
      logger
    ),
    tierMultiplier,
  };
}

/**
 * Choose the cost tier (#1675) for a lake from its owner type. The individual-vs-org distinction is
 * a lever pair, never a branch on a hard-coded number, so this function only picks WHICH configured
 * multiplier applies - the ratio between the two stays an operator's to tune.
 *
 * An absent `ownerType` means the caller could not establish who owns the work - the lake row was
 * unreadable, or there is no lake at all (the chunk handler reads the batch-size lever alone). A
 * money gate must not resolve that ambiguity in the spender's favour, so it takes the SMALLER of
 * the two tiers rather than assuming either one.
 *
 * Deliberately silent: "no owner" is routine for a caller that never had a lake, so warning here
 * would bury the case that actually matters. The gate warns where a lake WAS expected and could
 * not be read, and logs the tier it ended up applying.
 */
export function pickTierMultiplier(
  ownerType: SettingOwnerType | undefined,
  individual: number,
  organization: number
): number {
  if (ownerType === CreditHolderType.Organization) return organization;
  if (ownerType === CreditHolderType.User) return individual;
  return Math.min(individual, organization);
}

// Raw values are TYPED string|null but can arrive as number 0 or boolean false at runtime
// (the admin panel stores typed values; see the `?? null` note in getSettingsByNames). Every
// lever parser below therefore normalizes through String() before judging the value, so a
// stored 0 reads as "0" (a valid STOP) rather than crashing or slipping through a type hole.
const isAbsent = (raw: unknown): raw is null | undefined | '' => raw === null || raw === undefined || raw === '';

function halt(label: string, raw: unknown): never {
  throw new SpendLeverResolutionError(
    `unusable spend lever ${label}=${JSON.stringify(raw)}; halting spend rather than resuming at a default`
  );
}

function clamp(value: number, max: number, label: string, logger?: Logger): number {
  if (value <= max) return value;
  logger?.warn?.(`[spendLevers] ${label}=${value} exceeds the hard rail ${max}; clamping`);
  return max;
}

/**
 * Spend value in USD -> integer micro-USD. 0 is valid ("stop"); negative/NaN halts.
 *
 * `tierMultiplier` scales the configured budget for this lake's cost tier BEFORE the rail is
 * applied, so a generous tier still cannot lift spend past the platform ceiling. The default is
 * scaled too - a tier that only moved explicitly-set budgets would be a lever that does nothing on
 * a fresh install.
 */
function usdLeverToMicroUsd(
  raw: string | null | undefined,
  fallbackUsd: number,
  maxUsd: number,
  label: string,
  logger?: Logger,
  tierMultiplier = 1
): number {
  const baseUsd = isAbsent(raw) ? fallbackUsd : Number(String(raw));
  if (!Number.isFinite(baseUsd) || baseUsd < 0) halt(label, raw);
  // Name BOTH inputs when a tier is in play: the clamped figure is a PRODUCT, so a warning carrying
  // only the budget lever's key reports a value the operator never set and never mentions the
  // multiplier that caused it - which is also the lever they would have to change. The rail is
  // otherwise silent (no admin surface shows a tier being truncated), so the log is the only tell.
  const railLabel = tierMultiplier === 1 ? label : `${label}(${baseUsd}) x tier(${tierMultiplier})`;
  // Round, not floor: 0.29 * 1e6 is 289999.99999999994 in binary floating point, and a spend
  // budget must not silently lose a micro-USD to that.
  return Math.round(clamp(baseUsd * tierMultiplier, maxUsd, railLabel, logger) * MICRO_USD_PER_USD);
}

/** Ratio lever (a cost-tier multiplier): fractional values are legal, 0 is a valid "stop". */
function nonNegativeNumberLever(
  raw: string | null | undefined,
  fallback: number,
  max: number,
  label: string,
  logger?: Logger
): number {
  if (isAbsent(raw)) return fallback;
  const parsed = Number(String(raw));
  if (!Number.isFinite(parsed) || parsed < 0) halt(label, raw);
  return clamp(parsed, max, label, logger);
}

/** Integer lever where 0 is a valid "stop" value (e.g. the rate limit). */
function nonNegativeIntLever(
  raw: string | null | undefined,
  fallback: number,
  max: number,
  label: string,
  logger?: Logger
): number {
  if (isAbsent(raw)) return fallback;
  const parsed = Number(String(raw));
  if (!Number.isInteger(parsed) || parsed < 0) halt(label, raw);
  return clamp(parsed, max, label, logger);
}

/** Integer lever that is not itself a spend value, so 0 is a misconfiguration and halts too. */
function positiveIntLever(
  raw: string | null | undefined,
  fallback: number,
  max: number,
  label: string,
  logger?: Logger
): number {
  if (isAbsent(raw)) return fallback;
  const parsed = Number(String(raw));
  if (!Number.isInteger(parsed) || parsed < 1) halt(label, raw);
  return clamp(parsed, max, label, logger);
}

/** Boolean lever: only the literal strings true/false (any case) are acceptable when set. */
function booleanLever(raw: string | null | undefined, fallback: boolean, label: string): boolean {
  if (isAbsent(raw)) return fallback;
  const normalized = String(raw).toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  halt(label, raw);
}
