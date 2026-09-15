import { IOrgSlackWorkspaceDocument, IOrgSlackWorkspaceRepository, IMongoDocument } from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Organization-level Slack workspace connection schema.
 *
 * Stores per-workspace data when an org owner installs the B4M Slack app
 * into their workspace via self-service OAuth.
 */
const OrgSlackWorkspaceSchema = new Schema<IOrgSlackWorkspaceDocument>(
  {
    organizationId: { type: String, required: true },
    slackTeamId: { type: String, required: true },
    slackTeamName: { type: String, required: false },
    slackAppId: { type: String, required: true },
    slackBotToken: { type: String, required: false, select: false },
    slackBotUserId: { type: String, required: false },
    slackBotId: { type: String, required: false },
    enabled: { type: Boolean, default: true },
    installedAt: { type: Date, required: false },
    installedBy: { type: String, required: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// One workspace per organization
OrgSlackWorkspaceSchema.index({ organizationId: 1 }, { unique: true, name: 'org_slack_org_id' });

// Workspace exclusive to one org
OrgSlackWorkspaceSchema.index({ slackTeamId: 1 }, { unique: true, name: 'org_slack_team_id' });

export interface IOrgSlackWorkspaceModel extends Model<IOrgSlackWorkspaceDocument & IMongoDocument> {}

export const OrgSlackWorkspace: IOrgSlackWorkspaceModel =
  mongoose.models.OrgSlackWorkspace ?? model<IOrgSlackWorkspaceDocument>('OrgSlackWorkspace', OrgSlackWorkspaceSchema);

class OrgSlackWorkspaceRepository
  extends BaseRepository<IOrgSlackWorkspaceDocument & IMongoDocument>
  implements IOrgSlackWorkspaceRepository
{
  async findByOrganizationId(organizationId: string): Promise<(IOrgSlackWorkspaceDocument & IMongoDocument) | null> {
    return this.findOne({ organizationId });
  }

  async findBySlackTeamId(slackTeamId: string): Promise<(IOrgSlackWorkspaceDocument & IMongoDocument) | null> {
    return this.findOne({ slackTeamId, enabled: true });
  }

  /** Finds by slackTeamId regardless of enabled status - used for uniqueness checks. */
  async findBySlackTeamIdAny(slackTeamId: string): Promise<(IOrgSlackWorkspaceDocument & IMongoDocument) | null> {
    return this.findOne({ slackTeamId });
  }

  async findBySlackTeamIdWithToken(slackTeamId: string): Promise<(IOrgSlackWorkspaceDocument & IMongoDocument) | null> {
    const result = await this.model.findOne({ slackTeamId, enabled: true }).select('+slackBotToken');
    return result?.toJSON() || null;
  }

  async findByOrganizationIdWithToken(
    organizationId: string
  ): Promise<(IOrgSlackWorkspaceDocument & IMongoDocument) | null> {
    const result = await this.model.findOne({ organizationId, enabled: true }).select('+slackBotToken');
    return result?.toJSON() || null;
  }
}

export const orgSlackWorkspaceRepository = new OrgSlackWorkspaceRepository(OrgSlackWorkspace);

export default OrgSlackWorkspace;
