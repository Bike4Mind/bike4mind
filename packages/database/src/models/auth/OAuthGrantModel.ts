import { IMongoDocument, IBaseRepository } from '@bike4mind/common';
import mongoose, { Schema, model, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * A remembered user consent for an OAuth client: the (user, client) pair plus the set of scopes
 * the user has approved. One row per pair (unique index below); a re-consent widens `scopes`, a
 * revoke stamps `revokedAt`. The authorize flow upserts it before minting a code, and the token
 * endpoint requires it before issuing a relying-party access token.
 *
 * Deliberately shared across client-authorization surfaces: the federated ai-token exchange
 * (finding 277) is meant to read the same (user, client) grant. Keep this the single source of
 * truth rather than adding a parallel record.
 */
export interface IOAuthGrantDocument extends IMongoDocument {
  userId: string;
  clientId: string;
  scopes: string[];
  /** Where the grant was recorded, e.g. 'authorize' (interactive consent). Audit only. */
  source: string;
  /** Set when the user (or an admin) revokes; a revoked grant no longer satisfies findGrant. */
  revokedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IOAuthGrantRepository extends IBaseRepository<IOAuthGrantDocument> {
  /** The active (non-revoked) grant for this pair, or null. */
  findGrant(userId: string, clientId: string): Promise<IOAuthGrantDocument | null>;
  /** Create or widen the grant for this pair, clearing any prior revocation. */
  upsertGrant(params: {
    userId: string;
    clientId: string;
    scopes: string[];
    source: string;
  }): Promise<IOAuthGrantDocument | null>;
  /** Mark the grant revoked; the next authorization re-prompts. */
  revoke(userId: string, clientId: string): Promise<IOAuthGrantDocument | null>;
}

type IOAuthGrantModel = Model<IOAuthGrantDocument>;

const OAuthGrantSchema = new Schema<IOAuthGrantDocument>(
  {
    userId: { type: String, required: true },
    clientId: { type: String, required: true },
    scopes: { type: [String], default: [] },
    source: { type: String, default: 'authorize' },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One grant per (client, user); the upsert keys on it.
OAuthGrantSchema.index({ clientId: 1, userId: 1 }, { unique: true });

class OAuthGrantRepository extends BaseRepository<IOAuthGrantDocument> implements IOAuthGrantRepository {
  constructor(m: IOAuthGrantModel) {
    super(m);
  }

  findGrant(userId: string, clientId: string) {
    return this.model.findOne({ userId, clientId, revokedAt: null }).exec();
  }

  upsertGrant(params: { userId: string; clientId: string; scopes: string[]; source: string }) {
    return this.model
      .findOneAndUpdate(
        { clientId: params.clientId, userId: params.userId },
        { $set: { scopes: params.scopes, source: params.source, revokedAt: null } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )
      .exec();
  }

  revoke(userId: string, clientId: string) {
    return this.model.findOneAndUpdate({ userId, clientId }, { $set: { revokedAt: new Date() } }, { new: true }).exec();
  }
}

export const OAuthGrantModel =
  (mongoose.models['OAuthGrant'] as IOAuthGrantModel) ?? model<IOAuthGrantDocument>('OAuthGrant', OAuthGrantSchema);

export const oauthGrantRepository = new OAuthGrantRepository(OAuthGrantModel);
