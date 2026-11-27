import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

const SIDE_APP_REFUSAL_COUNTER_TTL_SECONDS = 90 * 24 * 60 * 60;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Hourly refusal count by reason for requests whose client id is only a claim. It never stores an id,
 * so a flood of invented ids cannot grow it beyond one row per (hour, reason).
 */
export interface ISideAppRefusalCounterDocument extends IMongoDocument {
  hour: Date;
  reason: string;
  count: number;
}

const SideAppRefusalCounterSchema = new mongoose.Schema<ISideAppRefusalCounterDocument>(
  {
    hour: { type: Date, required: true },
    reason: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
  },
  { versionKey: false }
);

SideAppRefusalCounterSchema.index({ hour: 1, reason: 1 }, { unique: true });
SideAppRefusalCounterSchema.index({ hour: 1 }, { expireAfterSeconds: SIDE_APP_REFUSAL_COUNTER_TTL_SECONDS });

export const SideAppRefusalCounter: Model<ISideAppRefusalCounterDocument> =
  mongoose.models.SideAppRefusalCounter ||
  mongoose.model<ISideAppRefusalCounterDocument>('SideAppRefusalCounter', SideAppRefusalCounterSchema);

export class SideAppRefusalCounterRepository extends BaseRepository<ISideAppRefusalCounterDocument> {
  constructor(model: Model<ISideAppRefusalCounterDocument>) {
    super(model);
  }

  async increment(reason: string, at: Date = new Date()): Promise<void> {
    const hour = new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
    await this.model.updateOne({ hour, reason }, { $inc: { count: 1 } }, { upsert: true });
  }
}

export const sideAppRefusalCounterRepository = new SideAppRefusalCounterRepository(SideAppRefusalCounter);
