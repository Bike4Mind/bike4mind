import mongoose, { Model, Schema } from 'mongoose';
import { ISlackDevWorkspaceDocument, ISlackDevWorkspaceRepository } from '@bike4mind/common';
import { softDeletePlugin } from '../../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'SlackDevWorkspace';

interface ISlackDevWorkspaceMethods {
}

interface ISlackDevWorkspaceModel extends Model<ISlackDevWorkspaceDocument, {}, ISlackDevWorkspaceMethods> {}

const SlackDevWorkspaceSchema = new Schema<
  ISlackDevWorkspaceDocument,
  ISlackDevWorkspaceModel,
  ISlackDevWorkspaceMethods
>(
  {
    name: { type: String, required: false },
    slackTeamId: { type: String, required: false }, // unique index defined below - now optional for workspaces created via manifest
    slackAppId: { type: String, required: true },
    slackBotUserId: { type: String, required: false }, // Optional - set during OAuth installation
    slackBotId: { type: String, required: false }, // Optional - set during OAuth installation
    slackBotToken: { type: String, required: false, select: false }, // Encrypted at rest via AES-256-GCM. Use decryptToken() after fetching. Excluded from queries by default (select: false) for defense-in-depth
    slackBotName: { type: String, required: false }, // Optional - set during OAuth installation
    isActive: { type: Boolean, required: true, default: true },
    installedAt: { type: Date, required: false }, // Optional - set during OAuth installation
    // OAuth App Credentials (from manifest creation)
    slackClientId: { type: String, required: false, select: false }, // OAuth Client ID
    slackClientSecret: { type: String, required: false, select: false }, // OAuth Client Secret (sensitive)
    slackOAuthSigningSecret: { type: String, required: false, select: false }, // Signing secret for OAuth app
    slackOAuthRedirectUri: { type: String, required: false }, // OAuth redirect URI
    slackVerificationToken: { type: String, required: false, select: false }, // Verification token (legacy)
    appConfigurationToken: { type: String, required: false, select: false }, // App config token for manifest management
    enableWorkflowSteps: { type: Boolean, required: false, default: true }, // Workflow Steps require paid Slack plan
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

SlackDevWorkspaceSchema.plugin(softDeletePlugin);

// No unique constraint on slackTeamId to allow multiple uninstalled workspaces (with null slackTeamId).
// Uniqueness is enforced at the application level during OAuth installation.
SlackDevWorkspaceSchema.index({ slackTeamId: 1 }, { sparse: true }); // Fast lookup by team ID (sparse: only index non-null values)
SlackDevWorkspaceSchema.index({ slackAppId: 1 }); // Fast lookup by app ID
SlackDevWorkspaceSchema.index({ isActive: 1 }); // Fast lookup of active workspaces
SlackDevWorkspaceSchema.index({ installedAt: -1 }); // Sort by installation date

export const SlackDevWorkspace: ISlackDevWorkspaceModel =
  (mongoose.models[ModelName] as ISlackDevWorkspaceModel) ??
  mongoose.model<ISlackDevWorkspaceDocument, ISlackDevWorkspaceModel>(ModelName, SlackDevWorkspaceSchema);

/**
 * Repository for Slack Dev Workspace operations
 */
class SlackDevWorkspaceRepository
  extends BaseRepository<ISlackDevWorkspaceDocument>
  implements ISlackDevWorkspaceRepository
{
  constructor(model: ISlackDevWorkspaceModel) {
    super(model);
  }

  /**
   * Find a workspace by Slack team ID
   * NOTE: Use .select('+slackBotToken') if you need the token
   */
  async findBySlackTeamId(slackTeamId: string): Promise<ISlackDevWorkspaceDocument | null> {
    const result = await this.model.findOne({ slackTeamId, isActive: true });
    return result?.toJSON() || null;
  }

  /**
   * Find all active workspaces
   */
  async findAllActive(): Promise<ISlackDevWorkspaceDocument[]> {
    const result = await this.model.find({ isActive: true }).sort({ installedAt: -1 });
    return result.map(r => r.toJSON());
  }

  /**
   * Find a workspace by Slack team ID (including inactive)
   * Use this for reinstall checks where we need to find deactivated workspaces
   */
  async findBySlackTeamIdIncludingInactive(slackTeamId: string): Promise<ISlackDevWorkspaceDocument | null> {
    const result = await this.model.findOne({ slackTeamId });
    return result?.toJSON() || null;
  }

  /**
   * Deactivate a workspace (soft delete)
   */
  async deactivate(workspaceId: string): Promise<ISlackDevWorkspaceDocument | null> {
    const result = await this.model.findByIdAndUpdate(
      workspaceId,
      { isActive: false, deletedAt: new Date() },
      { new: true }
    );
    return result?.toJSON() || null;
  }

  /**
   * Find a workspace by team ID and include the bot token
   * Use this when you need to make Slack API calls
   */
  async findBySlackTeamIdWithToken(slackTeamId: string): Promise<ISlackDevWorkspaceDocument | null> {
    const result = await this.model.findOne({ slackTeamId, isActive: true }).select('+slackBotToken');
    return result?.toJSON() || null;
  }

  /**
   * Find a workspace by Slack App ID
   * Used for apps created via manifest
   */
  async findBySlackAppId(slackAppId: string): Promise<ISlackDevWorkspaceDocument | null> {
    const result = await this.model
      .findOne({ slackAppId, isActive: true })
      .select('+slackClientId +slackClientSecret +slackOAuthSigningSecret');
    return result?.toJSON() || null;
  }

  /**
   * Find a workspace by Slack App ID and Team ID
   * Used for apps with known team ID during OAuth or event handling
   */
  async findBySlackAppIdAndTeamId(slackAppId: string, slackTeamId: string): Promise<ISlackDevWorkspaceDocument | null> {
    const result = await this.model.findOne({ slackAppId, slackTeamId, isActive: true });
    return result?.toJSON() || null;
  }

  /**
   * Find a workspace by ID with OAuth credentials included
   * Use this when you need the OAuth client ID and secret for InstallProvider
   */
  async findByIdWithCredentials(id: string): Promise<ISlackDevWorkspaceDocument | null> {
    const result = await this.model
      .findById(id)
      .select('+slackClientId +slackClientSecret +slackOAuthSigningSecret +slackBotToken');
    return result?.toJSON() || null;
  }

  /**
   * Find all active workspaces with OAuth credentials included
   * Use this when you need the OAuth client ID and secret for InstallProvider
   */
  async findAllActiveWithCredentials(): Promise<ISlackDevWorkspaceDocument[]> {
    const result = await this.model
      .find({ isActive: true })
      .select('+slackClientId +slackClientSecret +slackOAuthSigningSecret')
      .sort({ installedAt: -1 });
    return result.map(r => r.toJSON());
  }

  /**
   * Create or update workspace with OAuth credentials
   * Used when creating app via manifest
   */
  async createOrUpdateWithCredentials(data: {
    slackBotName?: string;
    slackAppId: string;
    slackClientId: string;
    slackClientSecret: string;
    slackOAuthSigningSecret: string;
    slackOAuthRedirectUri: string;
    slackVerificationToken?: string;
    enableWorkflowSteps?: boolean;
  }): Promise<ISlackDevWorkspaceDocument> {
    const workspace = await this.model.findOneAndUpdate(
      { slackAppId: data.slackAppId },
      {
        $set: {
          slackAppId: data.slackAppId,
          slackBotName: data.slackBotName,
          slackClientId: data.slackClientId,
          slackClientSecret: data.slackClientSecret,
          slackOAuthSigningSecret: data.slackOAuthSigningSecret,
          slackOAuthRedirectUri: data.slackOAuthRedirectUri,
          slackVerificationToken: data.slackVerificationToken,
          enableWorkflowSteps: data.enableWorkflowSteps ?? true,
          isActive: true,
          // Don't set installedAt - will be set during OAuth installation
        },
      },
      { upsert: true, new: true }
    );
    return workspace;
  }

  /**
   * Find a workspace by ID and include the bot token
   * Use this when you need to make Slack API calls (e.g., channel export)
   */
  async findByIdWithToken(id: string): Promise<ISlackDevWorkspaceDocument | null> {
    return this.model.findById(id).select('+slackBotToken');
  }

  /**
   * Find a workspace by ID and include the app configuration token
   * Use this for manifest management operations (export, update)
   */
  async findByIdWithConfigToken(id: string): Promise<ISlackDevWorkspaceDocument | null> {
    const result = await this.model.findById(id).select('+appConfigurationToken');
    return result?.toJSON() || null;
  }

  /**
   * Store or update the app configuration token for a workspace
   */
  async storeConfigToken(id: string, token: string): Promise<ISlackDevWorkspaceDocument | null> {
    const result = await this.model.findByIdAndUpdate(id, { $set: { appConfigurationToken: token } }, { new: true });
    return result?.toJSON() || null;
  }
}

export const slackDevWorkspaceRepository = new SlackDevWorkspaceRepository(SlackDevWorkspace);
export default SlackDevWorkspace;
