import { IMongoDocument, IBaseRepository } from '@bike4mind/common';
import bcrypt from 'bcryptjs';
import mongoose, { Schema, model, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Trust config for a Pattern-A *federated* client. Its presence turns an ordinary
 * "Sign in with B4M" client into one allowed to mint per-user `ai:generate`
 * keys via `POST /api/oauth/ai-token`, by exchanging an ID token the app already
 * holds for its logged-in user. Absent -> the client cannot mint AI keys.
 *
 * Two issuer shapes are supported, discriminated by `subjectSource`:
 *  - `'identities'` (default): the app's own AWS Cognito pool federates B4M as its
 *    upstream IdP, and the B4M user id arrives inside the Cognito `identities[]` claim.
 *  - `'sub'`: the app signs its users in against B4M's OIDC provider directly, so the
 *    B4M user id is the token's `sub` and there is no Cognito hop at all.
 *
 * NOTE: this schema is hand-duplicated in `packages/scripts/src/seed-oauth-client.ts`
 * (the seed script has no dependency on this package). Any field added here must be
 * mirrored there or seeding silently strips it.
 */
export interface IOAuthClientFederatedIdp {
  /** Expected `iss` of the ID token, e.g. `https://cognito-idp.<region>.amazonaws.com/<poolId>` or B4M's own APP_URL. */
  issuer: string;
  /**
   * JWKS endpoint. Defaults to `${issuer}/.well-known/jwks.json` (Cognito's layout)
   * when omitted, so it is REQUIRED for `subjectSource: 'sub'`: B4M publishes its
   * JWKS at `${issuer}/api/oauth/jwks`, which the default would never find.
   */
  jwksUri?: string;
  /** Expected `aud` claim - the app-client id (Cognito) or OAuth `client_id` (B4M) the token was issued to. */
  audience: string;
  /**
   * `identities[].providerName` that carries B4M's `sub` (== B4M user id) after
   * federation. Required for the `identities` source, meaningless for `sub`.
   */
  providerName?: string;
  /**
   * Where the B4M user id lives in the verified token. Absent means `'identities'`,
   * which is what keeps every already-registered client on its existing code path.
   */
  subjectSource?: 'identities' | 'sub';
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

/**
 * Conditional `required` for the federatedIdp subdocument. Deliberately no Mongoose
 * default on `subjectSource`: absent has to keep meaning `'identities'` so no stored
 * document changes meaning and no migration is needed.
 */
type FederatedIdpValidationContext = { subjectSource?: string };

function requiredWhenSubjectSourceIs(source: 'identities' | 'sub') {
  return function (this: FederatedIdpValidationContext) {
    return this.subjectSource === source;
  };
}

function requiredWhenSubjectSourceIsNot(source: 'identities' | 'sub') {
  return function (this: FederatedIdpValidationContext) {
    return this.subjectSource !== source;
  };
}

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
          // Required only for the `sub` source: the omitted-jwksUri default derives
          // Cognito's `/.well-known/jwks.json`, which 404s against B4M's own issuer.
          // Registration time is the only moment an integrator can fix that, so it is
          // a hard error here rather than a runtime verification failure later.
          jwksUri: { type: String, required: requiredWhenSubjectSourceIs('sub') },
          audience: { type: String, required: true },
          providerName: { type: String, required: requiredWhenSubjectSourceIsNot('sub') },
          subjectSource: { type: String, enum: ['identities', 'sub'] },
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
