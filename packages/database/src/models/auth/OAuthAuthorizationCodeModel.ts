import { IMongoDocument, IBaseRepository } from '@bike4mind/common';
import mongoose, { Schema, model, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export interface IOAuthAuthorizationCodeDocument extends IMongoDocument {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  nonce?: string;
  expiresAt: Date;
  used: boolean;
  createdAt: Date;
}

export interface IOAuthAuthorizationCodeRepository extends IBaseRepository<IOAuthAuthorizationCodeDocument> {
  findValidCode(code: string): Promise<IOAuthAuthorizationCodeDocument | null>;
  markUsed(id: string): Promise<void>;
}

type IOAuthAuthorizationCodeModel = Model<IOAuthAuthorizationCodeDocument>;

const OAuthAuthorizationCodeSchema = new Schema<IOAuthAuthorizationCodeDocument>(
  {
    code: { type: String, required: true, unique: true },
    clientId: { type: String, required: true },
    userId: { type: String, required: true },
    redirectUri: { type: String, required: true },
    scopes: { type: [String], default: [] },
    codeChallenge: { type: String },
    codeChallengeMethod: { type: String, enum: ['S256'] },
    nonce: { type: String },
    expiresAt: { type: Date, required: true },
    used: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// TTL index: auto-delete expired codes from MongoDB
OAuthAuthorizationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
OAuthAuthorizationCodeSchema.index({ code: 1, used: 1 });

class OAuthAuthorizationCodeRepository
  extends BaseRepository<IOAuthAuthorizationCodeDocument>
  implements IOAuthAuthorizationCodeRepository
{
  constructor(m: IOAuthAuthorizationCodeModel) {
    super(m);
  }

  findValidCode(code: string) {
    return this.model.findOne({ code, used: false, expiresAt: { $gt: new Date() } }).exec();
  }

  async markUsed(id: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { used: true } });
  }
}

export const OAuthAuthorizationCodeModel =
  (mongoose.models['OAuthAuthorizationCode'] as IOAuthAuthorizationCodeModel) ??
  model<IOAuthAuthorizationCodeDocument>('OAuthAuthorizationCode', OAuthAuthorizationCodeSchema);

export const oauthAuthorizationCodeRepository = new OAuthAuthorizationCodeRepository(OAuthAuthorizationCodeModel);
