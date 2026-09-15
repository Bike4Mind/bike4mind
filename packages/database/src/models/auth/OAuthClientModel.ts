import { IMongoDocument, IBaseRepository } from '@bike4mind/common';
import bcrypt from 'bcryptjs';
import mongoose, { Schema, model, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Trust config for a Pattern-A *federated* client: an app whose own AWS Cognito
 * pool federates B4M as its upstream IdP. Its presence turns an ordinary
 * "Sign in with B4M" client into one allowed to mint per-user `ai:generate`
 * keys via `POST /api/oauth/ai-token`, by exchanging a Cognito ID token the app
 * already holds for its logged-in user. Absent → the client cannot mint AI keys.
 */
export interface IOAuthClientFederatedIdp {
  /** Expected `iss` of the Cognito ID token, e.g. `https://cognito-idp.<region>.amazonaws.com/<poolId>`. */
  issuer: string;
  /** JWKS endpoint. Defaults to `${issuer}/.well-known/jwks.json` (Cognito) when omitted. */
  jwksUri?: string;
  /** Expected `aud` claim — the Cognito app-client id the token was issued to. */
  audience: string;
  /** `identities[].providerName` that carries B4M's `sub` (== B4M user id) after federation. */
  providerName: string;
}

export interface IOAuthClientDocument extends IMongoDocument {
  clientId: string;
  clientSecretHash: string;
  name: string; // e.g. "VibesWire", "VibesTrader"
  redirectUris: string[];
  allowedScopes: string[];
  pkceRequired: boolean;
  isActive: boolean;
  /** Populated only for Pattern-A federated clients; gates the AI-token exchange. */
  federatedIdp?: IOAuthClientFederatedIdp;
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
    // Pattern-A federated trust config. Absent (default) for ordinary "Sign in with B4M" clients;
    // its presence is the gate for the AI-token exchange endpoint. `_id: false` - it's an inline value.
    federatedIdp: {
      type: new Schema<IOAuthClientFederatedIdp>(
        {
          issuer: { type: String, required: true },
          jwksUri: { type: String },
          audience: { type: String, required: true },
          providerName: { type: String, required: true },
        },
        { _id: false }
      ),
      required: false,
    },
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
