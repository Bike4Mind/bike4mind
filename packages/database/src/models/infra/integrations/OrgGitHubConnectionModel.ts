import {
  IOrgGitHubConnectionDocument,
  IOrgGitHubConnectionRepository,
  IMongoDocument,
  IRateLimitInfo,
  IHealthInfo,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Organization-level GitHub API connection schema.
 *
 * Enables system-level GitHub API access for automation features like
 * LiveOps Triage without relying on per-user OAuth tokens.
 *
 * Supports two authentication methods:
 * - GitHub App: Preferred for production (automatic token rotation, scoped permissions)
 * - Service Account PAT: Simpler setup (Fine-grained PAT with manual rotation)
 */
const OrgGitHubConnectionSchema = new Schema<IOrgGitHubConnectionDocument>(
  {
    organizationId: { type: String, default: null },
    connectionType: {
      type: String,
      enum: ['github_app', 'service_account'],
      required: true,
    },

    // GitHub App fields
    appId: { type: String },
    installationId: { type: String },
    privateKey: { type: String, select: false }, // encrypted, excluded by default
    installationTargetType: { type: String, enum: ['Organization', 'User'] },
    installationTargetId: { type: Number },
    repositorySelection: { type: String, enum: ['all', 'selected'] },
    permissions: { type: Schema.Types.Mixed },

    // Token caching for serverless
    cachedAccessToken: { type: String, select: false }, // encrypted
    tokenExpiresAt: { type: Date },
    tokenCachedAt: { type: Date },

    // Suspension tracking
    suspendedAt: { type: Date },
    suspendedBy: { type: String },

    // Service Account PAT fields
    accessToken: { type: String, select: false }, // encrypted, excluded by default
    patExpiresAt: { type: Date },

    // Metadata
    connectedBy: { type: String, required: true },
    connectedAt: { type: Date, default: Date.now },
    allowedRepositories: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    isSystemDefault: { type: Boolean, default: false },

    // Health tracking
    lastUsedAt: { type: Date },
    lastError: { type: String },
    lastLatencyMs: { type: Number },

    // Rate limit tracking
    rateLimitRemaining: { type: Number },
    rateLimitLimit: { type: Number },
    rateLimitResetAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Unique index for organization (allows one connection per org, null for system default)
OrgGitHubConnectionSchema.index(
  { organizationId: 1 },
  {
    unique: true,
    sparse: true,
    name: 'org_github_connection_org_id',
    partialFilterExpression: { organizationId: { $ne: null } },
  }
);

// Index for system default lookup
OrgGitHubConnectionSchema.index({ isSystemDefault: 1 }, { name: 'org_github_connection_system_default' });

// Index for installation ID lookup (token caching)
OrgGitHubConnectionSchema.index({ installationId: 1 }, { sparse: true, name: 'org_github_connection_installation_id' });

export interface IOrgGitHubConnectionModel extends Model<IOrgGitHubConnectionDocument & IMongoDocument> {}

export const OrgGitHubConnection: IOrgGitHubConnectionModel =
  mongoose.models.OrgGitHubConnection ??
  model<IOrgGitHubConnectionDocument>('OrgGitHubConnection', OrgGitHubConnectionSchema);

class OrgGitHubConnectionRepository
  extends BaseRepository<IOrgGitHubConnectionDocument & IMongoDocument>
  implements IOrgGitHubConnectionRepository
{
  /**
   * Find connection by organization ID (enabled connections only)
   * Use this for operational queries where disabled connections should be invisible
   */
  async findByOrganizationId(organizationId: string): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    return this.findOne({ organizationId, enabled: true });
  }

  /**
   * Find connection by organization ID regardless of enabled status
   * Use this for management/admin queries where managers need to see disabled connections
   */
  async findByOrganizationIdAny(
    organizationId: string
  ): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    return this.findOne({ organizationId });
  }

  /**
   * Find connection by organization ID with credentials included (enabled only)
   */
  async findByOrganizationIdWithCredentials(
    organizationId: string
  ): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    const result = await this.model
      .findOne({ organizationId, enabled: true })
      .select('+privateKey +accessToken +cachedAccessToken');
    return result?.toJSON() || null;
  }

  /**
   * Find connection by organization ID with credentials (regardless of enabled status)
   * Use this for management/admin queries
   */
  async findByOrganizationIdAnyWithCredentials(
    organizationId: string
  ): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    const result = await this.model.findOne({ organizationId }).select('+privateKey +accessToken +cachedAccessToken');
    return result?.toJSON() || null;
  }

  /**
   * Atomic find and update for a connection
   * Returns the document BEFORE the update (for change tracking)
   * Prevents TOCTOU race conditions
   */
  async findOneAndUpdate(
    filter: { organizationId: string },
    update: Record<string, unknown>
  ): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    const result = await this.model.findOneAndUpdate(
      filter,
      { $set: update },
      { new: false } // Return document before update for change tracking
    );
    return result?.toJSON() || null;
  }

  /**
   * Find the system default connection
   */
  async findSystemDefault(): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    return this.findOne({ isSystemDefault: true, enabled: true });
  }

  /**
   * Find the system default connection with credentials included
   */
  async findSystemDefaultWithCredentials(): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    const result = await this.model
      .findOne({ isSystemDefault: true, enabled: true })
      .select('+privateKey +accessToken +cachedAccessToken');
    return result?.toJSON() || null;
  }

  /**
   * Find connection by installation ID (for token caching)
   */
  async findByInstallationId(installationId: string): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    return this.findOne({ installationId, enabled: true });
  }

  /**
   * Find connection by installation ID with cached token
   */
  async findByInstallationIdWithCachedToken(
    installationId: string
  ): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    const result = await this.model.findOne({ installationId, enabled: true }).select('+cachedAccessToken +privateKey');
    return result?.toJSON() || null;
  }

  /**
   * Update rate limit info
   */
  async updateRateLimitInfo(
    id: string,
    info: IRateLimitInfo
  ): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    return this.model.findByIdAndUpdate(
      id,
      {
        $set: {
          rateLimitRemaining: info.rateLimitRemaining,
          rateLimitLimit: info.rateLimitLimit,
          rateLimitResetAt: info.rateLimitResetAt,
        },
      },
      { new: true }
    );
  }

  /**
   * Update health info
   */
  async updateHealthInfo(
    id: string,
    info: IHealthInfo
  ): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    const update: Record<string, unknown> = {
      lastUsedAt: info.lastUsedAt,
    };
    if (info.lastLatencyMs !== undefined) {
      update.lastLatencyMs = info.lastLatencyMs;
    }
    if (info.lastError !== undefined) {
      update.lastError = info.lastError;
    } else {
      // Clear error on success
      update.lastError = null;
    }
    return this.model.findByIdAndUpdate(id, { $set: update }, { new: true });
  }

  /**
   * Update cached access token atomically.
   * Uses conditional update to prevent TOCTOU race conditions:
   * Only updates if no token exists OR existing token expires before new one.
   */
  async updateCachedToken(
    id: string,
    token: string,
    expiresAt: Date
  ): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    return this.model.findOneAndUpdate(
      {
        _id: id,
        $or: [{ tokenExpiresAt: { $exists: false } }, { tokenExpiresAt: null }, { tokenExpiresAt: { $lt: expiresAt } }],
      },
      {
        $set: {
          cachedAccessToken: token,
          tokenExpiresAt: expiresAt,
          tokenCachedAt: new Date(),
        },
      },
      { new: true }
    );
  }

  /**
   * Mark connection as suspended
   */
  async markSuspended(
    id: string,
    suspendedBy: string
  ): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    return this.model.findByIdAndUpdate(
      id,
      {
        $set: {
          suspendedAt: new Date(),
          suspendedBy,
        },
      },
      { new: true }
    );
  }

  /**
   * Clear suspension
   */
  async clearSuspension(id: string): Promise<(IOrgGitHubConnectionDocument & IMongoDocument) | null> {
    return this.model.findByIdAndUpdate(
      id,
      {
        $unset: {
          suspendedAt: 1,
          suspendedBy: 1,
        },
      },
      { new: true }
    );
  }
}

export const orgGitHubConnectionRepository = new OrgGitHubConnectionRepository(OrgGitHubConnection);

export default OrgGitHubConnection;
