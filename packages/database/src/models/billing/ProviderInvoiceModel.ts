import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  IProviderInvoice,
  IProviderInvoiceDocument,
  IProviderInvoiceInput,
  IProviderInvoiceRepository,
  ProviderInvoiceInput,
} from '@bike4mind/common';

/**
 * Entered provider invoice totals, one row per correction. Append-only: the
 * newest row per (month, provider) wins; see ProviderInvoiceTypes for why
 * deltas are never stored.
 */
const ProviderInvoiceSchema = new Schema<IProviderInvoiceDocument>(
  {
    month: { type: String, required: true },
    provider: { type: String, required: true },
    invoiceUsd: { type: Number, required: true },
    note: { type: String, required: true },
    enteredBy: { type: String, required: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

ProviderInvoiceSchema.index({ month: 1, provider: 1, createdAt: -1 });

export type IProviderInvoiceModel = Model<IProviderInvoiceDocument>;

export class ProviderInvoiceRepository
  extends BaseRepository<IProviderInvoiceDocument>
  implements IProviderInvoiceRepository
{
  constructor(model: IProviderInvoiceModel) {
    super(model);
  }

  async append(row: IProviderInvoiceInput): Promise<IProviderInvoiceDocument> {
    // Zod first: Mongoose alone accepts NaN amounts and malformed months.
    const parsed = ProviderInvoiceInput.parse(row);
    const newest = await this.model
      .findOne({ month: parsed.month, provider: parsed.provider })
      .sort({ createdAt: -1, _id: -1 });
    if (newest && newest.invoiceUsd === parsed.invoiceUsd && newest.note === parsed.note) {
      return newest;
    }
    const created = await this.create(parsed as IProviderInvoiceDocument);
    if (!created) throw new Error(`ProviderInvoice.append failed for ${parsed.month}/${parsed.provider}`);
    return created;
  }

  async newestPerMonthProvider(): Promise<IProviderInvoice[]> {
    const docs = await this.model.aggregate<IProviderInvoiceDocument>([
      // _id tiebreak: same-millisecond corrections still resolve newest-first.
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: { month: '$month', provider: '$provider' },
          doc: { $first: '$$ROOT' },
        },
      },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { month: -1, provider: 1 } },
    ]);
    return docs as IProviderInvoice[];
  }
}

export const ProviderInvoice =
  (mongoose.models['ProviderInvoice'] as unknown as IProviderInvoiceModel) ??
  model<IProviderInvoiceDocument>('ProviderInvoice', ProviderInvoiceSchema);
export const providerInvoiceRepository = new ProviderInvoiceRepository(ProviderInvoice);
