import { z } from 'zod';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * One reconciliation snapshot per (month, provider). The nightly cron fetches
 * each provider's authoritative billing total and compares it against our
 * internal COGS estimate (sum of UsageEvent.costUsd). Append-only: a new row
 * per run lets us track drift over time; the newest row per (month, provider)
 * is the current truth.
 */
export const SpendReconciliation = z.object({
  id: z.string().optional(),
  /** UTC month, YYYY-MM. */
  month: z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM'),
  /** Matches UsageEvent.provider values (e.g. "anthropic", "openai"). */
  provider: z.string().min(1),
  /** Provider-reported spend in USD for the month. */
  providerUsd: z.number().finite().nonnegative(),
  /** Our internal COGS estimate from UsageEvent aggregation. */
  internalUsd: z.number().finite().nonnegative(),
  /** providerUsd - internalUsd; positive = we underestimate. */
  deltaUsd: z.number().finite(),
  /** Absolute delta as a percentage of max(providerUsd, internalUsd) (0-100). */
  deltaPct: z.number().finite().nonnegative(),
  /** How the provider figure was obtained. */
  source: z.enum(['anthropic_admin_api', 'openai_usage_api', 'manual']),
  /** Optional detail: per-key or per-model breakdown from the provider. */
  providerBreakdown: z.record(z.string(), z.number()).optional(),
  /** Human-readable note (error messages, partial data warnings, etc.). */
  note: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ISpendReconciliation = z.infer<typeof SpendReconciliation>;

export type ISpendReconciliationDocument = ISpendReconciliation & IMongoDocument;

export const SpendReconciliationInput = SpendReconciliation.omit({ id: true, createdAt: true, updatedAt: true });

export type ISpendReconciliationInput = z.infer<typeof SpendReconciliationInput>;

export interface ISpendReconciliationRepository extends IBaseRepository<ISpendReconciliationDocument> {
  /** Append one reconciliation snapshot. */
  append(row: ISpendReconciliationInput): Promise<ISpendReconciliationDocument>;

  /** Newest row per (month, provider), sorted newest month first. */
  newestPerMonthProvider(): Promise<ISpendReconciliation[]>;

  /** Latest reconciliation per provider (most recent month only). */
  latestByProvider(): Promise<ISpendReconciliation[]>;

  /** All snapshots, newest first. For audit trail / drift-over-time views. */
  fullHistory(limit?: number): Promise<ISpendReconciliation[]>;
}
