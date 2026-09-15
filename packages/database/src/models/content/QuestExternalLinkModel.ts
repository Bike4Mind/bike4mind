import {
  IQuestExternalLinkDocument,
  IQuestExternalLinkRepository,
  QuestCapabilityType,
  ExternalLinkStatus,
  SyncDirection,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { IMongoDocument } from '@bike4mind/common';

const QuestExternalLinkSchema = new Schema<IQuestExternalLinkDocument>(
  {
    questPlanId: { type: String, required: true, index: true },
    questId: { type: String },

    // User and organization context (required for authorization and org-level webhooks)
    userId: { type: String, required: true, index: true },
    organizationId: { type: String, index: true },
    capabilityType: {
      type: String,
      enum: ['github', 'slack', 'jira', 'calendar', 'cli'] as QuestCapabilityType[],
      required: true,
    },

    // External system reference
    externalId: { type: String, required: true },
    externalUrl: { type: String, required: true },

    // Sync configuration
    syncDirection: {
      type: String,
      enum: ['push', 'pull', 'bidirectional'] as SyncDirection[],
      default: 'bidirectional',
    },
    status: {
      type: String,
      enum: ['synced', 'pending', 'conflict', 'error', 'disconnected', 'orphaned'] as ExternalLinkStatus[],
      default: 'pending',
      index: true,
    },

    // Version tracking
    localVersion: { type: String },
    remoteVersion: { type: String },
    lastSyncedAt: { type: Date },

    // GitHub-specific
    github: {
      type: {
        repository: { type: String, required: true },
        issueNumber: { type: Number },
        prNumber: { type: Number },
      },
      required: false,
    },

    // Slack-specific
    slack: {
      type: {
        channelId: { type: String, required: true },
        threadTs: { type: String },
        workspaceId: { type: String },
      },
      required: false,
    },

    // Jira-specific
    jira: {
      type: {
        projectKey: { type: String, required: true },
        issueKey: { type: String },
        cloudId: { type: String },
      },
      required: false,
    },

    // Calendar-specific
    calendar: {
      type: {
        calendarId: { type: String, required: true },
        eventId: { type: String },
        provider: { type: String, enum: ['google', 'microsoft', 'caldav'] },
      },
      required: false,
    },

    // CLI-specific
    cli: {
      type: {
        sessionId: { type: String, required: true },
        workingDirectory: { type: String },
      },
      required: false,
    },

    // Error tracking
    lastError: {
      type: {
        message: { type: String, required: true },
        code: { type: String },
        timestamp: { type: Date, required: true },
        retryCount: { type: Number, default: 0 },
      },
      required: false,
    },

    // Audit
    createdBy: { type: String, required: true },
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

// Compound indexes for efficient queries
QuestExternalLinkSchema.index({ capabilityType: 1, externalId: 1 });
QuestExternalLinkSchema.index({ 'github.repository': 1, 'github.issueNumber': 1 });
QuestExternalLinkSchema.index({ status: 1, 'lastError.retryCount': 1 });

// Unique compound index to prevent duplicate links (race condition protection)
QuestExternalLinkSchema.index(
  { questPlanId: 1, questId: 1, capabilityType: 1, externalId: 1 },
  { unique: true, name: 'quest_external_link_unique' }
);

export interface IQuestExternalLinkModel extends Model<IQuestExternalLinkDocument & IMongoDocument> {}

export const QuestExternalLink: IQuestExternalLinkModel =
  mongoose.models.QuestExternalLink ?? model<IQuestExternalLinkDocument>('QuestExternalLink', QuestExternalLinkSchema);

class QuestExternalLinkRepository
  extends BaseRepository<IQuestExternalLinkDocument & IMongoDocument>
  implements IQuestExternalLinkRepository
{
  /**
   * Find all external links for a quest plan (user-scoped for IDOR protection)
   */
  async findByQuestPlanId(questPlanId: string, userId: string): Promise<IQuestExternalLinkDocument[]> {
    return this.find({ questPlanId, userId });
  }

  /**
   * Find all external links for a specific sub-quest (user-scoped for IDOR protection)
   */
  async findByQuestId(questPlanId: string, questId: string, userId: string): Promise<IQuestExternalLinkDocument[]> {
    return this.find({ questPlanId, questId, userId });
  }

  /**
   * Find by external reference (user-scoped for IDOR protection)
   */
  async findByExternalId(
    capabilityType: QuestCapabilityType,
    externalId: string,
    userId: string
  ): Promise<IQuestExternalLinkDocument | null> {
    return this.findOne({ capabilityType, externalId, userId });
  }

  /**
   * Find GitHub link by repository and issue number (user-scoped for IDOR protection)
   */
  async findByGitHubIssue(
    repository: string,
    issueNumber: number,
    userId: string
  ): Promise<IQuestExternalLinkDocument | null> {
    return this.findOne({
      capabilityType: 'github',
      'github.repository': repository,
      'github.issueNumber': issueNumber,
      userId,
    });
  }

  async findPendingSync(limit = 100): Promise<IQuestExternalLinkDocument[]> {
    return this.find({ status: 'pending' }, { limit, sort: { createdAt: 1 } });
  }

  async findWithErrors(maxRetryCount = 3): Promise<IQuestExternalLinkDocument[]> {
    return this.find({
      status: 'error',
      'lastError.retryCount': { $lt: maxRetryCount },
    });
  }

  async updateSyncStatus(
    linkId: string,
    status: ExternalLinkStatus,
    versions?: { localVersion?: string; remoteVersion?: string }
  ): Promise<IQuestExternalLinkDocument | null> {
    const update: Partial<IQuestExternalLinkDocument> = {
      id: linkId,
      status,
      ...(versions?.localVersion && { localVersion: versions.localVersion }),
      ...(versions?.remoteVersion && { remoteVersion: versions.remoteVersion }),
    };

    if (status === 'synced') {
      update.lastSyncedAt = new Date();
    }

    return this.update(update);
  }

  async recordError(
    linkId: string,
    error: { message: string; code?: string }
  ): Promise<IQuestExternalLinkDocument | null> {
    // Get current doc to increment retry count
    const current = await this.findById(linkId);
    const currentRetryCount = current?.lastError?.retryCount ?? 0;

    return this.update({
      id: linkId,
      status: 'error',
      lastError: {
        message: error.message,
        code: error.code,
        timestamp: new Date(),
        retryCount: currentRetryCount + 1,
      },
    });
  }

  async markSynced(
    linkId: string,
    localVersion: string,
    remoteVersion: string
  ): Promise<IQuestExternalLinkDocument | null> {
    return this.update({
      id: linkId,
      status: 'synced',
      localVersion,
      remoteVersion,
      lastSyncedAt: new Date(),
      lastError: undefined, // Clear any previous errors
    });
  }
}

export const questExternalLinkRepository = new QuestExternalLinkRepository(QuestExternalLink);

export default QuestExternalLink;
