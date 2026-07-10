import mongoose, { Schema, model, Document, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * GearStamp — a first-use record for Gears (the earned-nav progression) whose
 * actions leave no other queryable trace: downloading a notebook, forking a
 * notebook, and similar fire-and-forget moments. Most gears are DERIVED from
 * existing data (see pages/api/gears/status.ts); a stamp exists only where
 * derivation is impossible.
 *
 * One row per (userId, key), enforced by the unique compound index — writers
 * upsert and treat E11000 as success (already stamped). Rows are permanent:
 * a gear, once earned, stays earned.
 */
export interface IGearStampDocument extends Document {
  id: string;
  userId: string;
  key: string;
  createdAt: Date;
  updatedAt: Date;
}

const GearStampSchema = new Schema(
  {
    userId: { type: String, required: true },
    key: { type: String, required: true, maxlength: 64 },
  },
  {
    timestamps: true,
    collection: 'gear_stamps',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

GearStampSchema.index({ userId: 1, key: 1 }, { unique: true });

export const GearStamp =
  (mongoose.models.GearStamp as mongoose.Model<IGearStampDocument>) ||
  model<IGearStampDocument>('GearStamp', GearStampSchema);

export class GearStampRepository extends BaseRepository<IGearStampDocument> {
  constructor(m: Model<IGearStampDocument>) {
    super(m);
  }

  /** Idempotent stamp: upsert; duplicate = already stamped = success. */
  async stamp(userId: string, key: string): Promise<void> {
    await this.model.updateOne({ userId, key }, { $setOnInsert: { userId, key } }, { upsert: true });
  }

  /**
   * Race-safe one-time claim: returns true for EXACTLY ONE caller across
   * concurrent requests (the one whose upsert inserted the row), false for the
   * rest. The (userId, key) unique index is the arbiter. Used to decide which
   * of N concurrent /gears/status calls announces a fresh reward, so the credit
   * grant (idempotent on its own ledger key) is reported to the user only once.
   */
  async claimOnce(userId: string, key: string): Promise<boolean> {
    const r = await this.model.updateOne({ userId, key }, { $setOnInsert: { userId, key } }, { upsert: true });
    return (r.upsertedCount ?? 0) === 1;
  }

  async stampedKeys(userId: string): Promise<Set<string>> {
    const rows = await this.model.find({ userId }).select('key').lean<Array<{ key: string }>>();
    return new Set(rows.map(r => r.key));
  }
}

export const gearStampRepository = new GearStampRepository(GearStamp);
