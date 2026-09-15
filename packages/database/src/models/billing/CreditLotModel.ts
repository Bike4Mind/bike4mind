import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  CreditHolderType,
  CreditLotSources,
  ICreditLot,
  ICreditLotRepository,
  IMongoDocument,
} from '@bike4mind/common';

export type ICreditLotDocument = ICreditLot & IMongoDocument;

const CreditLotSchema = new Schema<ICreditLotDocument>(
  {
    ownerId: { type: String, required: true },
    ownerType: { type: String, required: true, enum: ['User', 'Organization', 'Agent'] as CreditHolderType[] },
    source: { type: String, required: true, enum: [...CreditLotSources] },
    amount: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    consumedAssigned: { type: Number, required: true, default: 0 },
    stripeRef: { type: String, required: false },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Drives both the sweep's per-holder lot walk (ownerId+ownerType, ordered
// soonest-to-expire) and the live balance/expiringSoon computation.
CreditLotSchema.index({ ownerId: 1, ownerType: 1, expiresAt: 1 });
// Clawback handlers look up the lot to reduce by Stripe payment intent id.
CreditLotSchema.index({ stripeRef: 1 });

export type ICreditLotModel = Model<ICreditLotDocument>;

export class CreditLotRepository extends BaseRepository<ICreditLotDocument> implements ICreditLotRepository {
  constructor(model: ICreditLotModel) {
    super(model);
  }

  async findByOwner(ownerId: string, ownerType: CreditHolderType) {
    return this.model.find({ ownerId, ownerType }).sort({ expiresAt: 1 });
  }

  async findByStripeRef(stripeRef: string) {
    return this.model.find({ stripeRef });
  }
}

export const CreditLot =
  (mongoose.models['CreditLot'] as unknown as ICreditLotModel) ??
  model<ICreditLotDocument>('CreditLot', CreditLotSchema);
export const creditLotRepository = new CreditLotRepository(CreditLot);
