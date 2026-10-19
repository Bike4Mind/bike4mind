import {
  IMcpOAuthClientRegistration,
  IMcpOAuthClientRegistrationDocument,
  IMcpOAuthClientRegistrationRepository,
  IMongoDocument,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

const McpOAuthClientRegistrationSchema = new Schema<IMcpOAuthClientRegistrationDocument>(
  {
    issuer: { type: String, required: true },
    redirectUri: { type: String, required: true },
    clientId: { type: String, required: true },
    clientSecretEnc: { type: String, select: false },
    /** Absent means the secret never expires (RFC 7591 `client_secret_expires_at: 0`). */
    clientSecretExpiresAt: { type: Date },
    registrationAccessTokenEnc: { type: String, select: false },
    tokenEndpointAuthMethod: { type: String, required: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// One registration per authorization server and redirect URI, shared by every user of the deployment.
McpOAuthClientRegistrationSchema.index(
  { issuer: 1, redirectUri: 1 },
  { unique: true, name: 'mcpoauthclientreg_issuer_redirect' }
);

const WITH_CREDENTIALS = '+clientSecretEnc +registrationAccessTokenEnc';

export interface IMcpOAuthClientRegistrationModel extends Model<IMcpOAuthClientRegistrationDocument & IMongoDocument> {}
export const McpOAuthClientRegistration: IMcpOAuthClientRegistrationModel =
  mongoose.models.McpOAuthClientRegistration ??
  model<IMcpOAuthClientRegistrationDocument>('McpOAuthClientRegistration', McpOAuthClientRegistrationSchema);

class McpOAuthClientRegistrationRepository
  extends BaseRepository<IMcpOAuthClientRegistrationDocument & IMongoDocument>
  implements IMcpOAuthClientRegistrationRepository
{
  /**
   * Insert or replace the registration for (issuer, redirectUri). Replacing is right when a
   * registration expired or was rejected; two racing first registrations converge on the last one.
   * Two concurrent upserts of a missing row can both try the insert and one gets E11000; the row
   * exists by then, so one retry takes the update path.
   */
  async upsert(registration: IMcpOAuthClientRegistration): Promise<IMcpOAuthClientRegistrationDocument> {
    try {
      return await this.upsertOnce(registration);
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000) throw error;
      return this.upsertOnce(registration);
    }
  }

  /** A registration whose client secret has expired reads as a miss, so the caller re-registers. */
  async findByIssuerAndRedirect(
    issuer: string,
    redirectUri: string
  ): Promise<IMcpOAuthClientRegistrationDocument | null> {
    const result = await this.model
      .findOne({
        issuer,
        redirectUri,
        $or: [{ clientSecretExpiresAt: null }, { clientSecretExpiresAt: { $gt: new Date() } }],
      })
      .select(WITH_CREDENTIALS);
    return result?.toJSON() ?? null;
  }

  private async upsertOnce(registration: IMcpOAuthClientRegistration): Promise<IMcpOAuthClientRegistrationDocument> {
    const { issuer, redirectUri, ...rest } = registration;
    const unset: Record<string, 1> = {};
    if (rest.clientSecretEnc === undefined) unset.clientSecretEnc = 1;
    if (rest.clientSecretExpiresAt === undefined) unset.clientSecretExpiresAt = 1;
    if (rest.registrationAccessTokenEnc === undefined) unset.registrationAccessTokenEnc = 1;
    const result = await this.model
      .findOneAndUpdate(
        { issuer, redirectUri },
        { $set: rest, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
        { new: true, upsert: true }
      )
      .select(WITH_CREDENTIALS);
    return result.toJSON();
  }
}

export const mcpOAuthClientRegistrationRepository = new McpOAuthClientRegistrationRepository(
  McpOAuthClientRegistration
);

export default McpOAuthClientRegistration;
