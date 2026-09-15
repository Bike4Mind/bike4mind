import { z } from 'zod';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * One entered provider invoice total for one UTC month. Rows are append-only:
 * a correction is a NEW row, and the newest row per (month, provider) wins.
 * Deltas against recorded COGS are always computed at read time - recorded
 * COGS moves with late-arriving events, so a stored delta would go stale.
 */
export const ProviderInvoice = z.object({
  id: z.string().optional(),
  /** UTC month, matching monthlyCogsByProvider's group key. */
  month: z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM'),
  /** Matches UsageEvent.provider values. */
  provider: z.string().min(1),
  invoiceUsd: z.number().finite().nonnegative(),
  /** Provenance: invoice id and its billing period, e.g. "INV-123, Aug 1-31 UTC-8". */
  note: z.string().min(1),
  /** Admin user who entered the row. */
  enteredBy: z.string().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type IProviderInvoice = z.infer<typeof ProviderInvoice>;

export type IProviderInvoiceDocument = IProviderInvoice & IMongoDocument;

/** Zod schema for appending a row (server sets id/timestamps). */
export const ProviderInvoiceInput = ProviderInvoice.omit({ id: true, createdAt: true, updatedAt: true });

export type IProviderInvoiceInput = z.infer<typeof ProviderInvoiceInput>;

export interface IProviderInvoiceRepository extends IBaseRepository<IProviderInvoiceDocument> {
  /** Append one row; returns the existing newest row instead when it already
   * carries the same invoiceUsd and note (idempotent re-submit). */
  append(row: IProviderInvoiceInput): Promise<IProviderInvoiceDocument>;

  /** Newest row per (month, provider). */
  newestPerMonthProvider(): Promise<IProviderInvoice[]>;
}
