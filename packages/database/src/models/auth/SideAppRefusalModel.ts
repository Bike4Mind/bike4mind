import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export const SIDE_APP_REFUSAL_STAGES = ['mint', 'use'] as const;
export type SideAppRefusalStage = (typeof SIDE_APP_REFUSAL_STAGES)[number];

const SIDE_APP_REFUSAL_TTL_SECONDS = 90 * 24 * 60 * 60;

/** One row per refusal whose client id was proven by a verified client secret or an exchange key. */
export interface ISideAppRefusalDocument extends IMongoDocument {
  clientId: string;
  stage: SideAppRefusalStage;
  reason: string;
  status: number;
  userId?: string;
  keyId?: string;
  endpoint?: string;
  createdAt: Date;
}

const SideAppRefusalSchema = new mongoose.Schema<ISideAppRefusalDocument>(
  {
    clientId: { type: String, required: true },
    stage: { type: String, required: true, enum: SIDE_APP_REFUSAL_STAGES },
    reason: { type: String, required: true },
    status: { type: Number, required: true },
    userId: { type: String },
    keyId: { type: String },
    endpoint: { type: String },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false }
);

SideAppRefusalSchema.index({ clientId: 1, createdAt: -1 });
SideAppRefusalSchema.index({ createdAt: 1 }, { expireAfterSeconds: SIDE_APP_REFUSAL_TTL_SECONDS });

export const SideAppRefusal: Model<ISideAppRefusalDocument> =
  mongoose.models.SideAppRefusal || mongoose.model<ISideAppRefusalDocument>('SideAppRefusal', SideAppRefusalSchema);

export class SideAppRefusalRepository extends BaseRepository<ISideAppRefusalDocument> {
  constructor(model: Model<ISideAppRefusalDocument>) {
    super(model);
  }

  async record(input: Omit<ISideAppRefusalDocument, 'id' | 'createdAt' | 'updatedAt'>): Promise<void> {
    await this.model.create({ ...input, createdAt: new Date() });
  }
}

export const sideAppRefusalRepository = new SideAppRefusalRepository(SideAppRefusal);
