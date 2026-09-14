import { IMongoDocument, IBaseRepository } from '@bike4mind/common';
import mongoose, { Schema, model, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * A durable record that a B4M user authorized a specific OAuth client - the
 * B4M-side authorization grant the federated AI-token exchange
 * (`POST /api/oauth/ai-token`) requires before minting a key.
 *
 * Created when the user completes the `/oauth/code` authorize flow for the
 * client. For Pattern-A federated apps that is the user's federated first login:
 * their Cognito pool federates B4M as its upstream IdP, so the `identities[]`
 * entry the exchange resolves against can only exist because the user passed
 * through `/oauth/code` here. The grant is what a compromised pool cannot forge -
 * a forged token for a user who never authorized this client finds no grant.
 *
 * Unlike an auth code this is NOT TTL-expired; it persists until explicitly
 * revoked (Google/GitHub "authorized apps" model).
 */
export interface IOAuthGrantDocument extends IMongoDocument {
  userId: string;
  clientId: string;
  /** Scopes granted at authorize time. Informational: the exchange checks grant existence, not scopes. */
  scopes: string[];
  status: 'active' | 'revoked';
  revokedAt?: Date;
  revokedBy?: string;
  /** Refreshed on every re-authorize; lets a future idle-grant cleanup reason about staleness. */
  lastGrantedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IOAuthGrantRepository extends IBaseRepository<IOAuthGrantDocument> {
  findActiveGrant(userId: string, clientId: string): Promise<IOAuthGrantDocument | null>;
  upsertGrant(userId: string, clientId: string, scopes: string[]): Promise<IOAuthGrantDocument>;
  revokeGrant(userId: string, clientId: string, revokedBy?: string): Promise<void>;
}

type IOAuthGrantModel = Model<IOAuthGrantDocument>;

const OAuthGrantSchema = new Schema<IOAuthGrantDocument>(
  {
    userId: { type: String, required: true },
    clientId: { type: String, required: true },
    scopes: { type: [String], default: [] },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    revokedAt: { type: Date },
    revokedBy: { type: String },
    lastGrantedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// One grant per (client, user). Client-first so the same index also serves a
// future per-client enumeration ("who authorized client X").
OAuthGrantSchema.index({ clientId: 1, userId: 1 }, { unique: true });

class OAuthGrantRepository extends BaseRepository<IOAuthGrantDocument> implements IOAuthGrantRepository {
  constructor(m: IOAuthGrantModel) {
    super(m);
  }

  findActiveGrant(userId: string, clientId: string) {
    return this.model.findOne({ userId, clientId, status: 'active' }).exec();
  }

  async upsertGrant(userId: string, clientId: string, scopes: string[]): Promise<IOAuthGrantDocument> {
    // Re-authorizing reactivates a previously revoked grant and refreshes scopes:
    // the user is present and consenting again, so honor it rather than dead-end.
    const doc = await this.model
      .findOneAndUpdate(
        { userId, clientId },
        {
          $set: { scopes, status: 'active', lastGrantedAt: new Date() },
          $unset: { revokedAt: '', revokedBy: '' },
        },
        { new: true, upsert: true }
      )
      .exec();
    // upsert + new guarantees a document at runtime; the driver types it nullable.
    return doc as IOAuthGrantDocument;
  }

  async revokeGrant(userId: string, clientId: string, revokedBy?: string): Promise<void> {
    await this.model.updateOne(
      { userId, clientId, status: 'active' },
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy } }
    );
  }
}

export const OAuthGrantModel =
  (mongoose.models['OAuthGrant'] as IOAuthGrantModel) ?? model<IOAuthGrantDocument>('OAuthGrant', OAuthGrantSchema);

export const oauthGrantRepository = new OAuthGrantRepository(OAuthGrantModel);
