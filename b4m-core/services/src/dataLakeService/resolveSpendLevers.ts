import {
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
  DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_DEFAULT,
  DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_MAX,
  IAdminSettingsRepository,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';

export const MICRO_USD_PER_USD = 1_000_000;

/**
 * Effective spend levers for data-lake embedding work. Budgets are integer micro-USD
 * (1e-6 USD): a single embedded chunk can cost ~$0.0001, so cents-level integers would
 * meter most runs as free.
 */
export interface DataLakeSpendLevers {
  spendEnabled: boolean;
  perRunBudgetMicroUsd: number;
  perLakeBudgetMicroUsd: number;
  perPeriodBudgetMicroUsd: number;
  periodHours: number;
  maxCallsPerMinute: number;
  vectorizeChunkBatchSize: number;
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
 */
export async function resolveSpendLevers(
  db: { adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'> },
  logger?: Logger
): Promise<DataLakeSpendLevers> {
  let values: Record<string, string | null>;
  try {
    values = await getSettingsByNames(
      [
        'dataLakeEmbeddingSpendEnabled',
        'dataLakeEmbeddingBudgetPerRunUsd',
        'dataLakeEmbeddingBudgetPerLakeUsd',
        'dataLakeEmbeddingBudgetPerPeriodUsd',
        'dataLakeEmbeddingBudgetPeriodHours',
        'dataLakeEmbeddingMaxCallsPerMinute',
        'dataLakeVectorizeChunkBatchSize',
      ],
      db,
      { logger }
    );
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

  return {
    spendEnabled: booleanLever(values.dataLakeEmbeddingSpendEnabled, true, 'dataLakeEmbeddingSpendEnabled'),
    perRunBudgetMicroUsd: usdLeverToMicroUsd(
      values.dataLakeEmbeddingBudgetPerRunUsd,
      DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_DEFAULT,
      DATA_LAKE_EMBEDDING_BUDGET_PER_RUN_USD_MAX,
      'dataLakeEmbeddingBudgetPerRunUsd',
      logger
    ),
    perLakeBudgetMicroUsd: usdLeverToMicroUsd(
      values.dataLakeEmbeddingBudgetPerLakeUsd,
      DATA_LAKE_EMBEDDING_BUDGET_PER_LAKE_USD_DEFAULT,
      DATA_LAKE_EMBEDDING_BUDGET_PER_LAKE_USD_MAX,
      'dataLakeEmbeddingBudgetPerLakeUsd',
      logger
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
    vectorizeChunkBatchSize: positiveIntLever(
      values.dataLakeVectorizeChunkBatchSize,
      DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_DEFAULT,
      DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_MAX,
      'dataLakeVectorizeChunkBatchSize',
      logger
    ),
  };
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

/** Spend value in USD -> integer micro-USD. 0 is valid ("stop"); negative/NaN halts. */
function usdLeverToMicroUsd(
  raw: string | null | undefined,
  fallbackUsd: number,
  maxUsd: number,
  label: string,
  logger?: Logger
): number {
  if (isAbsent(raw)) return fallbackUsd * MICRO_USD_PER_USD;
  const parsed = Number(String(raw));
  if (!Number.isFinite(parsed) || parsed < 0) halt(label, raw);
  return Math.round(clamp(parsed, maxUsd, label, logger) * MICRO_USD_PER_USD);
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
