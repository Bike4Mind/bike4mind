import { IOrgJiraConnectionDocument, IOrgJiraConnectionRepository, IMongoDocument } from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Organization-level Jira API connection schema.
 *
 * Enables org-scoped Jira access for automation features like LiveOps Triage,
 * replacing the system-level ATLASSIAN_* environment configuration for
 * multi-tenant deployments. Mirrors OrgGitHubConnectionModel: one connection
 * per organization, plus an optional system default (organizationId: null).
 */
const OrgJiraConnectionSchema = new Schema<IOrgJiraConnectionDocument>(
  {
    organizationId: { type: String, default: null },
    cloudId: { type: String, required: true },
    siteUrl: { type: String, required: true },
    accessToken: { type: String, select: false }, // encrypted, excluded by default

    // Metadata
    connectedBy: { type: String, required: true },
    connectedAt: { type: Date, default: Date.now },
    enabled: { type: Boolean, default: true },
    isSystemDefault: { type: Boolean, default: false },

    // Health tracking
    lastUsedAt: { type: Date },
    lastError: { type: String },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Unique index for organization (one connection per org; the partial filter
// excludes null so multiple system-default rows don't collide)
OrgJiraConnectionSchema.index(
  { organizationId: 1 },
  {
    unique: true,
    name: 'org_jira_connection_org_id',
    partialFilterExpression: { organizationId: { $type: 'string' } },
  }
);

// Index for system default lookup
OrgJiraConnectionSchema.index({ isSystemDefault: 1 }, { name: 'org_jira_connection_system_default' });

export interface IOrgJiraConnectionModel extends Model<IOrgJiraConnectionDocument & IMongoDocument> {}

export const OrgJiraConnection: IOrgJiraConnectionModel =
  mongoose.models.OrgJiraConnection ?? model<IOrgJiraConnectionDocument>('OrgJiraConnection', OrgJiraConnectionSchema);

class OrgJiraConnectionRepository
  extends BaseRepository<IOrgJiraConnectionDocument & IMongoDocument>
  implements IOrgJiraConnectionRepository
{
  async findByOrganizationId(organizationId: string): Promise<(IOrgJiraConnectionDocument & IMongoDocument) | null> {
    return this.findOne({ organizationId, enabled: true });
  }

  async findByOrganizationIdAny(organizationId: string): Promise<(IOrgJiraConnectionDocument & IMongoDocument) | null> {
    return this.findOne({ organizationId });
  }

  async findByOrganizationIdWithCredentials(
    organizationId: string
  ): Promise<(IOrgJiraConnectionDocument & IMongoDocument) | null> {
    const result = await this.model.findOne({ organizationId, enabled: true }).select('+accessToken');
    return result?.toJSON() || null;
  }

  async findSystemDefault(): Promise<(IOrgJiraConnectionDocument & IMongoDocument) | null> {
    return this.findOne({ isSystemDefault: true, enabled: true });
  }

  async findSystemDefaultWithCredentials(): Promise<(IOrgJiraConnectionDocument & IMongoDocument) | null> {
    const result = await this.model.findOne({ isSystemDefault: true, enabled: true }).select('+accessToken');
    return result?.toJSON() || null;
  }
}

export const orgJiraConnectionRepository = new OrgJiraConnectionRepository(OrgJiraConnection);

export default OrgJiraConnection;
