import { IMongoDocument, IBaseRepository } from '@bike4mind/common';
import mongoose, { Schema, model, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * A remembered user consent for an OAuth client: the (user, client) pair plus the set of scopes
 * the user has approved. One row per pair (unique index below); an active consent widens `scopes`,
 * and consenting after revocation starts a fresh scope set. The authorize flow upserts it before
 * minting a code, and the token endpoint requires it before issuing a relying-party access token.
 *
 * Deliberately shared across client-authorization surfaces: the federated ai-token exchange is
 * meant to read the same (user, client) grant. Keep this the single source of truth rather than
 * adding a parallel record.
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
  /** All active (non-revoked) grants for this user, most-recently approved first. */
  listActiveByUser(userId: string): Promise<IOAuthGrantDocument[]>;
  /** Create or widen an active grant; replace revoked scopes with the newly approved scopes. */
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
const MAX_GRANT_UPSERT_ATTEMPTS = 3;

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
// Covers listActiveByUser: equality on userId + revokedAt, sort on updatedAt (most-recently
// re-approved first -- approvedAt in the API response comes from updatedAt).
OAuthGrantSchema.index({ userId: 1, revokedAt: 1, updatedAt: -1 });

class OAuthGrantRepository extends BaseRepository<IOAuthGrantDocument> implements IOAuthGrantRepository {
  constructor(m: IOAuthGrantModel) {
    super(m);
  }

  findGrant(userId: string, clientId: string) {
    return this.model.findOne({ userId, clientId, revokedAt: null }).exec();
  }

  listActiveByUser(userId: string) {
    return this.model.find({ userId, revokedAt: null }).sort({ updatedAt: -1 }).exec();
  }

  async upsertGrant(params: { userId: string; clientId: string; scopes: string[]; source: string }) {
    const filter = { clientId: params.clientId, userId: params.userId };
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        // Only one concurrent re-consent can reactivate the row. Discard the revoked scopes;
        // later consents widen the now-active row rather than overwriting this approval.
        const reactivated = await this.model
          .findOneAndUpdate(
            { ...filter, revokedAt: { $ne: null } },
            { $set: { scopes: [...new Set(params.scopes)], source: params.source, revokedAt: null } },
            { new: true }
          )
          .exec();
        if (reactivated) return reactivated;

        return await this.model
          .findOneAndUpdate(
            { ...filter, revokedAt: null },
            {
              $addToSet: { scopes: { $each: params.scopes } },
              $set: { source: params.source, revokedAt: null },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          )
          .exec();
      } catch (error: unknown) {
        // An initial insert or a revoke between the guarded writes can race the unique index.
        // Retry both guards, never an unguarded union that could revive revoked permissions.
        const duplicateKey = typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
        if (!duplicateKey || attempt >= MAX_GRANT_UPSERT_ATTEMPTS) throw error;
      }
    }
  }

  revoke(userId: string, clientId: string) {
    return this.model
      .findOneAndUpdate({ userId, clientId, revokedAt: null }, { $set: { revokedAt: new Date() } }, { new: true })
      .exec();
  }
}

export const OAuthGrantModel =
  (mongoose.models['OAuthGrant'] as IOAuthGrantModel) ?? model<IOAuthGrantDocument>('OAuthGrant', OAuthGrantSchema);

export const oauthGrantRepository = new OAuthGrantRepository(OAuthGrantModel);
