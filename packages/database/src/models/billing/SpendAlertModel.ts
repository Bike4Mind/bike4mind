import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  IMongoDocument,
  ISpendAlert,
  ISpendAlertRepository,
  SPEND_ROLLUP_SCOPE_TYPES,
  SPEND_RULE_IDS,
  SpendAlertRecord,
} from '@bike4mind/common';

export type ISpendAlertDocument = ISpendAlert & IMongoDocument;

const SpendAlertSchema = new Schema<ISpendAlertDocument>(
  {
    rule: { type: String, required: true, enum: [...SPEND_RULE_IDS] },
    scopeType: { type: String, required: true, enum: [...SPEND_ROLLUP_SCOPE_TYPES] },
    scopeId: { type: String, required: true },
    openKey: { type: String },
    status: { type: String, required: true, enum: ['open', 'acknowledged', 'resolved'] },
    severity: { type: String, required: true, enum: ['warning', 'critical'] },
    openedAt: { type: Date, required: true },
    peakValue: { type: Number, required: true },
    lastValue: { type: Number, required: true },
    lastNotifiedValue: { type: Number },
    lastNotifiedAt: { type: Date },
    clearRuns: { type: Number, required: true, default: 0 },
    acknowledgedBy: { type: String },
    acknowledgedAt: { type: Date },
    resolvedAt: { type: Date },
    context: { type: Schema.Types.Mixed, required: true, default: {} },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// Sparse so resolved incidents (openKey unset) never collide; this is what de-duplicates open incidents.
SpendAlertSchema.index({ openKey: 1 }, { unique: true, sparse: true });
SpendAlertSchema.index({ status: 1, openedAt: -1 });
SpendAlertSchema.index({ scopeType: 1, scopeId: 1, openedAt: -1 });

export type ISpendAlertModel = Model<ISpendAlertDocument>;

export class SpendAlertRepository extends BaseRepository<ISpendAlertDocument> implements ISpendAlertRepository {
  constructor(model: ISpendAlertModel) {
    super(model);
  }

  async findActive(): Promise<SpendAlertRecord[]> {
    const docs = await this.model.find({ status: { $in: ['open', 'acknowledged'] } });
    return docs.map(doc => doc.toJSON() as SpendAlertRecord);
  }
}

export const SpendAlert =
  (mongoose.models['SpendAlert'] as unknown as ISpendAlertModel) ??
  model<ISpendAlertDocument>('SpendAlert', SpendAlertSchema);
export const spendAlertRepository = new SpendAlertRepository(SpendAlert);
