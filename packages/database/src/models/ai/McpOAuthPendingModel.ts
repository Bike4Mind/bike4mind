import {
  IMcpOAuthPendingDocument,
  IMcpOAuthPendingRepository,
  IMongoDocument,
  MCP_OAUTH_PENDING_TTL_SECONDS,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

const McpOAuthPendingSchema = new Schema<IMcpOAuthPendingDocument>(
  {
    stateHash: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    connectionId: { type: String, required: true },
    codeVerifierEnc: { type: String, required: true, select: false },
    redirectUri: { type: String, required: true },
    issuer: { type: String, required: true },
    resource: { type: String, required: true },
    scopes: { type: [String], default: [] },
    consumedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Abandoned attempts clean themselves up; no sweep cron (design 15).
McpOAuthPendingSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: MCP_OAUTH_PENDING_TTL_SECONDS, name: 'mcpoauthpending_ttl' }
);

export interface IMcpOAuthPendingModel extends Model<IMcpOAuthPendingDocument & IMongoDocument> {}
export const McpOAuthPending: IMcpOAuthPendingModel =
  mongoose.models.McpOAuthPending ?? model<IMcpOAuthPendingDocument>('McpOAuthPending', McpOAuthPendingSchema);

class McpOAuthPendingRepository
  extends BaseRepository<IMcpOAuthPendingDocument & IMongoDocument>
  implements IMcpOAuthPendingRepository
{
  async create(data: Omit<IMcpOAuthPendingDocument, 'id' | 'updatedAt' | 'createdAt'>) {
    const created = await super.create(data);
    delete (created as { codeVerifierEnc?: string }).codeVerifierEnc;
    return created;
  }

  /**
   * Single use: the `consumedAt: null` filter makes a replayed or concurrent callback lose. The TTL
   * monitor only runs about once a minute, so expiry is also checked here rather than trusted to it.
   * Resolves with `codeVerifierEnc`, which the callback needs for the code exchange.
   */
  async consume(stateHash: string): Promise<IMcpOAuthPendingDocument | null> {
    const now = new Date();
    const result = await this.model
      .findOneAndUpdate(
        {
          stateHash,
          consumedAt: null,
          createdAt: { $gt: new Date(now.getTime() - MCP_OAUTH_PENDING_TTL_SECONDS * 1000) },
        },
        { $set: { consumedAt: now } },
        { new: true }
      )
      .select('+codeVerifierEnc');
    return result?.toJSON() ?? null;
  }
}

export const mcpOAuthPendingRepository = new McpOAuthPendingRepository(McpOAuthPending);

export default McpOAuthPending;
