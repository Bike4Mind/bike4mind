import { IMongoDocument, IBaseRepository } from '@bike4mind/common';
import mongoose, { Schema, model, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * A relying-party OAuth refresh-token family (RFC 9700 2.2.2): one row per issued chain, holding
 * only the sha256 of the CURRENT secret. Each use rotates the hash; presenting a superseded secret
 * revokes the family. Kept apart from AuthSession on purpose: the first-party refresh paths rotate
 * any AuthSession row into a full session, so an RP token stored there could be escalated.
 *
 * Hashing and expiry math live with the caller (apps/client server/auth/oauthRefreshToken.ts); this
 * repository only stores and compare-and-swaps hashes.
 */
export interface IOAuthRefreshTokenDocument extends IMongoDocument {
  familyId: string;
  userId: string;
  clientId: string;
  scopes: string[];
  tokenHash: string;
  /** The user's tokenVersion at issue; a bump (logout-everywhere, password reset) kills the family. */
  tokenVersion: number;
  expiresAt: Date;
  revokedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IOAuthRefreshTokenRepository extends IBaseRepository<IOAuthRefreshTokenDocument> {
  findByFamilyId(familyId: string): Promise<IOAuthRefreshTokenDocument | null>;
  /**
   * Compare-and-swap the current hash. Only matches a live (non-revoked, unexpired) family whose
   * hash is still `expectedHash`, so of two concurrent rotations exactly one wins; the loser gets null.
   */
  rotate(
    familyId: string,
    params: { expectedHash: string; nextHash: string; newExpiresAt: Date }
  ): Promise<IOAuthRefreshTokenDocument | null>;
  revokeFamily(familyId: string): Promise<void>;
  /** Revoke every live family for a (user, client) pair, e.g. when the user revokes the grant. */
  revokeAllForGrant(userId: string, clientId: string): Promise<void>;
}

type IOAuthRefreshTokenModel = Model<IOAuthRefreshTokenDocument>;

const OAuthRefreshTokenSchema = new Schema<IOAuthRefreshTokenDocument>(
  {
    familyId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    clientId: { type: String, required: true },
    scopes: { type: [String], default: [] },
    tokenHash: { type: String, required: true },
    tokenVersion: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Mongo deletes a family shortly after it expires; callers still check expiresAt themselves.
OAuthRefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
OAuthRefreshTokenSchema.index({ userId: 1, clientId: 1, revokedAt: 1 });

class OAuthRefreshTokenRepository
  extends BaseRepository<IOAuthRefreshTokenDocument>
  implements IOAuthRefreshTokenRepository
{
  constructor(m: IOAuthRefreshTokenModel) {
    super(m);
  }

  findByFamilyId(familyId: string) {
    return this.model.findOne({ familyId }).exec();
  }

  rotate(familyId: string, params: { expectedHash: string; nextHash: string; newExpiresAt: Date }) {
    return this.model
      .findOneAndUpdate(
        { familyId, tokenHash: params.expectedHash, revokedAt: null, expiresAt: { $gt: new Date() } },
        { $set: { tokenHash: params.nextHash, expiresAt: params.newExpiresAt } },
        { new: true }
      )
      .exec();
  }

  async revokeFamily(familyId: string) {
    await this.model.updateOne({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } }).exec();
  }

  async revokeAllForGrant(userId: string, clientId: string) {
    await this.model.updateMany({ userId, clientId, revokedAt: null }, { $set: { revokedAt: new Date() } }).exec();
  }
}

export const OAuthRefreshTokenModel =
  (mongoose.models['OAuthRefreshToken'] as IOAuthRefreshTokenModel) ??
  model<IOAuthRefreshTokenDocument>('OAuthRefreshToken', OAuthRefreshTokenSchema);

export const oauthRefreshTokenRepository = new OAuthRefreshTokenRepository(OAuthRefreshTokenModel);
