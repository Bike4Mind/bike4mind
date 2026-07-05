import { IMongoDocument, IBaseRepository } from '@bike4mind/common';
import bcrypt from 'bcryptjs';
import mongoose, { Schema, model, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export interface IOAuthClientDocument extends IMongoDocument {
  clientId: string;
  clientSecretHash: string;
  name: string; // e.g. "VibesWire", "VibesTrader"
  redirectUris: string[];
  allowedScopes: string[];
  pkceRequired: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IOAuthClientRepository extends IBaseRepository<IOAuthClientDocument> {
  findByClientId(clientId: string): Promise<IOAuthClientDocument | null>;
  verifyClientSecret(clientId: string, secret: string): Promise<IOAuthClientDocument | null>;
}

type IOAuthClientModel = Model<IOAuthClientDocument>;

const OAuthClientSchema = new Schema<IOAuthClientDocument>(
  {
    clientId: { type: String, required: true, unique: true },
    clientSecretHash: { type: String, required: true },
    name: { type: String, required: true },
    redirectUris: [{ type: String, required: true }],
    allowedScopes: { type: [String], default: ['openid', 'email', 'profile'] },
    pkceRequired: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        (ret as Partial<typeof ret>).clientSecretHash = undefined;
        return ret;
      },
    },
  }
);

OAuthClientSchema.index({ clientId: 1, isActive: 1 });

class OAuthClientRepository extends BaseRepository<IOAuthClientDocument> implements IOAuthClientRepository {
  constructor(m: IOAuthClientModel) {
    super(m);
  }

  findByClientId(clientId: string) {
    return this.model.findOne({ clientId, isActive: true }).exec();
  }

  async verifyClientSecret(clientId: string, secret: string): Promise<IOAuthClientDocument | null> {
    const client = await this.model.findOne({ clientId, isActive: true }).select('+clientSecretHash').exec();
    if (!client) return null;
    const match = await bcrypt.compare(secret, client.clientSecretHash);
    return match ? client : null;
  }
}

export const OAuthClientModel =
  (mongoose.models['OAuthClient'] as IOAuthClientModel) ??
  model<IOAuthClientDocument>('OAuthClient', OAuthClientSchema);

export const oauthClientRepository = new OAuthClientRepository(OAuthClientModel);
