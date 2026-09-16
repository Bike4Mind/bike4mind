import { IMongoDocument, IBaseRepository } from '@bike4mind/common';
import bcrypt from 'bcryptjs';
import mongoose, { Schema, model, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Trust config for a Pattern-A *federated* client. Its presence turns an ordinary
 * "Sign in with B4M" client into one allowed to mint per-user `ai:generate` keys via
 * `POST /api/oauth/ai-token`, by exchanging an ID token the app already holds for its
 * logged-in user. Absent means the client cannot mint AI keys.
 *
 * Two issuer shapes, discriminated by `issuer` (see verifyFederatedIdToken.ts):
 * an external AWS Cognito pool that federates B4M upstream, or B4M itself for an app
 * that signs users in directly against B4M.
 */
export interface IOAuthClientFederatedIdp {
  /**
   * Expected `iss` of the ID token: a Cognito pool
   * (`https://cognito-idp.<region>.amazonaws.com/<poolId>`), or B4M's own OIDC issuer
   * (APP_URL) for a B4M-issued token.
   */
  issuer: string;
  /**
   * JWKS endpoint. Optional for a Cognito pool (defaults to
   * `${issuer}/.well-known/jwks.json`); REQUIRED when the issuer is B4M itself, whose
   * canonical endpoint is `${issuer}/api/oauth/jwks` and must not be derived.
   */
  jwksUri?: string;
  /** Expected `aud` claim: the app-client id the token was issued to. */
  audience: string;
  /**
   * `identities[].providerName` that carries B4M's `sub` (== B4M user id) after
   * federation. Required for the external-Cognito shape; unused for a B4M-issued token,
   * whose subject is plain `sub`.
   */
  providerName?: string;
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
          providerName: { type: String },
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
