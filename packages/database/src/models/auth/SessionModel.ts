import mongoose, { Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { ShareableDocumentRepository, ShareableDocumentSchema } from '../content/SharableDocumentModel';
import { ISession, ISessionDocument, ISessionRepository, SearchOptions } from '@bike4mind/common';
import { softDeletePlugin } from '../../utils/mongo';
import User from './UserModel';
import { NotFoundError } from '@bike4mind/utils';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { Quest as QuestModel } from '../content/QuestModel';

// This is the canonical name of the model, used in determining the collection name in Mongo.
// If this changes, you'll need to adjust a few parallel mentions in the code (build will fail
// and tell you which ones).  You'll also need to move any documents in the old collection to
// the new one.
const ModelName = 'SessionModel';

const TagSchema = new Schema(
  {
    name: { type: String, required: true },
    strength: { type: Number, required: true },
  },
  {
    _id: false,
    id: false,
    versionKey: false,
  }
);

export interface ISessionModel extends Model<ISessionDocument> {}

const SessionSchema = new Schema<ISession, ISessionModel, {}>(
  {
    name: { type: String, required: true },
    userId: { type: String, required: true },
    lastUpdated: { type: Date, required: true },
    firstCreated: { type: Date, required: true },
    language: { type: String, required: false },
    knowledgeIds: [{ type: String, required: false }],
    artifactIds: [{ type: String, required: false }],
    toolIds: [{ type: String, required: false }],
    agentIds: [{ type: String, required: false }],
    systemPromptText: { type: String, required: false },
    surface: { type: String, required: false },
    enabledTools: [{ type: String, required: false }],
    disabledTools: [{ type: String, required: false }],
    disableUserIntegrations: { type: Boolean, required: false },
    forceKnowledgeRetrieval: { type: Boolean, required: false },
    retrievalTags: [{ type: String, required: false }],
    retrievalExcludeFilenameMarkers: [{ type: String, required: false }],
    retrievalVectorizedOnly: { type: Boolean, required: false },
    citationStyle: { type: String, enum: ['named', 'indexed'], required: false },
    temperature: { type: Number, required: false },
    maxToolCalls: { type: Number, required: false, min: 1 },
    autoNamePlaceholder: { type: String, required: false },
    openaiConversationId: { type: String, required: false },
    claudeConversationId: { type: String, required: false },
    summary: { type: String, required: false },
    summaryAt: { type: Date, required: false },
    summaryModelId: { type: String, required: false },
    summaryTrigger: {
      type: String,
      enum: ['manual', 'project', 'milestone', 'growth', 'throttling'],
      required: false,
    },
    contextSummary: { type: String, required: false },
    contextSummaryUpToQuestId: { type: String, required: false },
    contextSummaryAt: { type: Date, required: false },
    contextSummaryModelId: { type: String, required: false },
    tags: { type: [TagSchema], required: false },
    clonedSourceId: { type: String, required: false },
    forkedSourceId: { type: String, required: false },
    isAutoNamed: { type: Boolean, required: false },
    lastUsedModel: { type: String, required: false },
    curatedNotebookFileId: { type: String, required: false }, // Points to the latest curated markdown file
    curatedAt: { type: Date, required: false }, // When the notebook was last curated
    curationContentHash: { type: String, required: false }, // Hash of the last curation's inputs (content + type + options); lets an unchanged re-curation reuse the file and skip the LLM
    messageCount: { type: Number, required: false }, // Lazy-loaded count of messages - calculated on first read
    slackMetadata: {
      type: {
        channelId: { type: String, required: true },
        threadTs: { type: String, required: false },
        createdFromSlack: { type: Boolean, required: true },
        workspaceId: { type: String, required: false }, // For async notification
      },
      required: false,
      _id: false,
    },
    // Conversation context for low-effort prompt handling
    // Tracks recently mentioned entities to enable reference resolution
    conversationContext: {
      type: {
        github: {
          type: {
            repos: [
              {
                owner: { type: String, required: true },
                repo: { type: String, required: true },
                mentionedAt: { type: Date, required: true },
                source: { type: String, enum: ['user', 'assistant', 'tool_result'], required: true },
              },
            ],
            prs: [
              {
                owner: { type: String, required: true },
                repo: { type: String, required: true },
                number: { type: Number, required: true },
                title: { type: String, required: false },
                mentionedAt: { type: Date, required: true },
                source: { type: String, enum: ['user', 'assistant', 'tool_result'], required: true },
              },
            ],
            issues: [
              {
                owner: { type: String, required: true },
                repo: { type: String, required: true },
                number: { type: Number, required: true },
                title: { type: String, required: false },
                mentionedAt: { type: Date, required: true },
                source: { type: String, enum: ['user', 'assistant', 'tool_result'], required: true },
              },
            ],
          },
          required: false,
          _id: false,
        },
        jira: {
          type: {
            projects: [
              {
                key: { type: String, required: true },
                name: { type: String, required: false },
                mentionedAt: { type: Date, required: true },
                source: { type: String, enum: ['user', 'assistant', 'tool_result'], required: true },
              },
            ],
            issues: [
              {
                key: { type: String, required: true },
                summary: { type: String, required: false },
                mentionedAt: { type: Date, required: true },
                source: { type: String, enum: ['user', 'assistant', 'tool_result'], required: true },
              },
            ],
          },
          required: false,
          _id: false,
        },
        confluence: {
          type: {
            spaces: [
              {
                key: { type: String, required: true },
                name: { type: String, required: false },
                mentionedAt: { type: Date, required: true },
                source: { type: String, enum: ['user', 'assistant', 'tool_result'], required: true },
              },
            ],
            pages: [
              {
                id: { type: String, required: true },
                title: { type: String, required: true },
                spaceKey: { type: String, required: false },
                mentionedAt: { type: Date, required: true },
                source: { type: String, enum: ['user', 'assistant', 'tool_result'], required: true },
              },
            ],
          },
          required: false,
          _id: false,
        },
        lastUpdated: { type: Date, required: true },
      },
      required: false,
      _id: false,
    },
    voiceReservedCredits: { type: Number, required: false, default: null },
    voiceSessionStartedAt: { type: Date, required: false, default: null },
    ...ShareableDocumentSchema,
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

export class SessionRepository extends BaseRepository<ISessionDocument> implements ISessionRepository {
  shareable: ISessionRepository['shareable'];
  private questModel?: Model<unknown>;

  constructor(
    private sessionModel: ISessionModel,
    extensions: {
      shareable: ISessionRepository['shareable'];
      questModel?: Model<unknown>;
    }
  ) {
    super(sessionModel);
    this.sessionModel = sessionModel;
    this.shareable = extensions.shareable;
    this.questModel = extensions.questModel;
  }

  set ctx(ctx: mongoose.mongo.ClientSession | null) {
    this.ctx = ctx;
  }

  async search(
    search: string | undefined,
    filters: {
      userId?: string;
      shared?: boolean;
      projectIds?: string[];
    },
    pagination: {
      page: number;
      limit: number;
    },
    orderBy: {
      field: string;
      direction: 'asc' | 'desc';
    }
  ) {
    const user = await User.findById(filters.userId!);
    const findQuery = this.sessionModel.find();

    if (!user) throw new NotFoundError('User not found');

    if (search) {
      findQuery.where('name', { $regex: escapeRegex(search), $options: 'si' });
    }

    if (filters.shared && filters.userId) {
      findQuery.where(this.shareable.findAllAccessible(user));
    } else if (filters.userId) {
      findQuery.where('userId', filters.userId);
    }

    if (filters.projectIds) {
      findQuery.where('projectIds', { $in: filters.projectIds });
    }

    const total = await this.sessionModel.countDocuments(findQuery.getQuery());

    findQuery
      .skip(pagination.limit * (pagination.page - 1))
      .limit(pagination.limit + 1)
      .sort({ [orderBy.field]: orderBy.direction });

    const result = await findQuery.exec();
    const hasMore = result.length === pagination.limit + 1;
    if (hasMore) result.pop();

    // Lazy-load message counts for all returned sessions
    const sessionsWithCounts = await this.populateMessageCounts(result);

    return {
      data: sessionsWithCounts,
      hasMore,
      total,
    };
  }

  async upsertByOpenaiConversationId(openaiConversationId: string, update: Partial<ISession>) {
    const query = this.sessionModel.findOneAndUpdate(
      { openaiConversationId },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    // Only attach an explicit session when one is set; .session(null) overrides
    // transactionAsyncLocalStorage propagation and silently breaks atomicity.
    if (this.ctx) {
      query.session(this.ctx);
    }
    return query;
  }
  async upsertByClaudeConversationId(claudeConversationId: string, update: Partial<ISession>) {
    const query = this.sessionModel.findOneAndUpdate(
      { claudeConversationId },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    // See `upsertByOpenaiConversationId` above.
    if (this.ctx) {
      query.session(this.ctx);
    }
    return query;
  }
  async findByIdAndUserId(id: string, userId: string) {
    return this.sessionModel.findOne({ _id: id, userId });
  }
  async findRecentlyUpdatedByUserId(userId: string, ctx: mongoose.mongo.ClientSession | null = null) {
    const query = this.sessionModel.findOne({ userId }).sort({ lastUpdated: -1 }).limit(1);
    // Gate on truthy session; default `ctx = null` would otherwise pass
    // .session(null) and silently override ALS propagation.
    if (ctx) {
      query.session(ctx);
    }
    return query;
  }
  async searchByUserId(
    search: string | undefined,
    userId: string,
    options: SearchOptions<ISessionDocument>,
    surface?: string
  ) {
    const q: Record<string, unknown> = {
      userId: userId,
    };

    // Surface scoping: a specific surface returns only that product's sessions;
    // otherwise the main list excludes product-surface sessions ({ surface: null }
    // matches docs where the field is null OR absent).
    q.surface = surface ? surface : null;

    if (search) {
      // Search name, summary, and tags via $or for better discovery.
      const escapedSearch = escapeRegex(search);
      q['$or'] = [
        { name: { $regex: escapedSearch, $options: 'si' } },
        { summary: { $regex: escapedSearch, $options: 'si' } },
        { 'tags.name': { $regex: escapedSearch, $options: 'si' } },
      ];
    }

    const { pagination, orderBy } = options || {};

    const result = await this.sessionModel
      .find(q)
      .skip(pagination.limit * (pagination.page - 1))
      .limit(pagination.limit + 1)
      .sort({ [orderBy.field]: orderBy.direction });

    const hasMore = result.length === pagination.limit + 1;
    if (hasMore) result.pop();

    // Lazy-load message counts for all returned sessions
    const sessionsWithCounts = await this.populateMessageCounts(result);

    return {
      data: sessionsWithCounts,
      hasMore,
    };
  }
  async findAllWithKnowledgeId(knowledgeId: string) {
    return this.sessionModel.find({ knowledgeIds: { $in: [knowledgeId] } });
  }
  async findAllByIds(ids: string[]) {
    return this.sessionModel.find({ _id: { $in: ids } });
  }

  async attachAgent(sessionId: string, agentId: string) {
    const session = await this.sessionModel.findByIdAndUpdate(
      sessionId,
      { $addToSet: { agentIds: agentId } },
      { new: true }
    );
    if (!session) {
      throw new NotFoundError('Session not found');
    }
    return session;
  }

  async detachAgent(sessionId: string, agentId: string) {
    const session = await this.sessionModel.findByIdAndUpdate(
      sessionId,
      { $pull: { agentIds: agentId } },
      { new: true }
    );
    if (!session) {
      throw new NotFoundError('Session not found');
    }
    return session;
  }

  async getAttachedAgents(sessionId: string) {
    const session = await this.sessionModel.findById(sessionId, 'agentIds');
    if (!session) {
      throw new NotFoundError('Session not found');
    }
    return session.agentIds || [];
  }

  async addArtifact(sessionId: string, artifactId: string) {
    const session = await this.sessionModel.findByIdAndUpdate(
      sessionId,
      { $addToSet: { artifactIds: artifactId } },
      { new: true }
    );
    if (!session) {
      throw new NotFoundError('Session not found');
    }
    return session;
  }

  async removeArtifact(sessionId: string, artifactId: string) {
    const session = await this.sessionModel.findByIdAndUpdate(
      sessionId,
      { $pull: { artifactIds: artifactId } },
      { new: true }
    );
    if (!session) {
      throw new NotFoundError('Session not found');
    }
    return session;
  }

  async getAttachedArtifacts(sessionId: string) {
    const session = await this.sessionModel.findById(sessionId, 'artifactIds');
    if (!session) {
      throw new NotFoundError('Session not found');
    }
    return session.artifactIds || [];
  }

  async countByUserId(userId: string) {
    const deletedAtFilter = {
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    };
    return this.sessionModel.countDocuments({ userId, ...deletedAtFilter });
  }

  async countActiveVoiceSessionsByUserId(userId: string) {
    const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
    return this.sessionModel.countDocuments({
      userId,
      voiceSessionStartedAt: { $gte: sixtyMinutesAgo },
    });
  }

  async findSessionIdsByUserId(userId: string) {
    const deletedAtFilter = {
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    };

    const sessions = await this.sessionModel.find({ userId, ...deletedAtFilter }, { _id: 1 });
    // Filter out any sessions with null/undefined _id to prevent toString() errors
    return sessions.filter(s => s._id != null).map(s => s._id.toString());
  }

  /**
   * Lazy-load message count for a session if not already calculated
   * This allows gradual population of messageCount without requiring a migration
   *
   * Uses atomic findOneAndUpdate to prevent race conditions where two concurrent
   * requests both try to calculate and set the count.
   *
   * @param sessionId - The session ID
   * @returns The message count for the session
   */
  async ensureMessageCount(sessionId: string): Promise<number> {
    // First, try to get existing count with atomic check-and-return
    const existingSession = await this.sessionModel.findById(sessionId, { messageCount: 1 });

    if (!existingSession) {
      return 0;
    }

    // If messageCount is already set, return it immediately
    if (existingSession.messageCount !== undefined && existingSession.messageCount !== null) {
      return existingSession.messageCount;
    }

    // Calculate the count - prefer injected questModel, fall back to dynamic lookup
    const Quest = this.questModel || mongoose.models.Quest || mongoose.model('Quest');
    const messageCount = await Quest.countDocuments({
      sessionId: sessionId,
      deletedAt: { $exists: false },
    });

    // Atomically set the count ONLY if it's still null/undefined (first writer wins)
    // This prevents race conditions where two requests calculate different counts
    const updated = await this.sessionModel.findOneAndUpdate(
      {
        _id: sessionId,
        $or: [{ messageCount: { $exists: false } }, { messageCount: null }],
      },
      { $set: { messageCount } },
      { new: true }
    );

    // If update succeeded, return our calculated count
    // If update failed (another request set it first), return the existing value
    if (updated) {
      return messageCount;
    }

    // Another request set the count first, fetch the current value
    const refreshed = await this.sessionModel.findById(sessionId, { messageCount: 1 });
    return refreshed?.messageCount ?? messageCount;
  }

  /**
   * Populate message counts for an array of sessions (lazy-load pattern)
   * Only calculates and caches for sessions that don't have messageCount set
   *
   * @param sessions - Array of session documents
   * @returns The same array with messageCount populated
   */
  async populateMessageCounts(sessions: ISessionDocument[]): Promise<ISessionDocument[]> {
    // Prefer injected questModel, fall back to dynamic lookup
    const Quest = this.questModel || mongoose.models.Quest || mongoose.model('Quest');

    // Identify sessions that need messageCount calculated
    const sessionsNeedingCount = sessions.filter(s => s.messageCount === undefined || s.messageCount === null);

    if (sessionsNeedingCount.length === 0) {
      return sessions; // All sessions already have counts
    }

    // Batch count all messages for sessions needing counts
    const sessionIds = sessionsNeedingCount.map(s => s.id);

    const messageCounts = await Quest.aggregate([
      {
        $match: {
          sessionId: { $in: sessionIds },
          $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
        },
      },
      {
        $group: {
          _id: '$sessionId',
          count: { $sum: 1 },
        },
      },
    ]);

    // Create a map of sessionId -> messageCount
    const countMap = new Map(messageCounts.map((mc: { _id: string; count: number }) => [mc._id, mc.count]));

    // Update sessions in database (batch upsert) and in-memory array
    const bulkOps = sessionsNeedingCount.map(session => {
      const count = countMap.get(session.id) || 0;
      session.messageCount = count; // Update in-memory

      return {
        updateOne: {
          filter: { _id: session.id },
          update: { $set: { messageCount: count } },
        },
      };
    });

    if (bulkOps.length > 0) {
      await this.sessionModel.bulkWrite(bulkOps);
    }

    return sessions;
  }
}
SessionSchema.plugin(softDeletePlugin);

// Optimize session listing - used on homepage and many screens
SessionSchema.index({ deletedAt: 1, userId: 1, lastUpdated: -1 });

// Optimize permission and sharing queries
SessionSchema.index({ deletedAt: 1, 'users.permissions': 1, 'users.userId': 1 });

// Optimize global access patterns
SessionSchema.index({ deletedAt: 1, isGlobalRead: 1 });

// Tag-based search indexes
SessionSchema.index({ deletedAt: 1, 'tags.name': 1, userId: 1 });

// Optimized index for searchCollections query - sessionmodels collection
SessionSchema.index({ userId: 1, deletedAt: 1, name: 'text', updatedAt: -1 });

// Optimize Slack thread-based notebook lookups.
// unique: true prevents duplicate notebooks for the same thread (race condition fix);
// partialFilterExpression only indexes docs with Slack thread metadata, preserving
// backward compatibility for notebooks without slackMetadata.
SessionSchema.index(
  { userId: 1, 'slackMetadata.channelId': 1, 'slackMetadata.threadTs': 1 },
  {
    unique: true,
    // partial index: only index docs where slackMetadata exists
    partialFilterExpression: {
      slackMetadata: { $exists: true, $ne: null },
    },
  }
);

// Index for admin/cleanup queries on conversation context by user.
// Feature queries use findById(sessionId), which hits the default _id index;
// this index supports "find all sessions with context for user X".
SessionSchema.index(
  { userId: 1, 'conversationContext.lastUpdated': -1 },
  {
    // partial index: only index docs where conversationContext exists
    partialFilterExpression: {
      'conversationContext.lastUpdated': { $exists: true },
    },
  }
);

// Index for countActiveVoiceSessionsByUserId - runs on every voice session creation
SessionSchema.index({ userId: 1, voiceSessionStartedAt: 1 }, { sparse: true });

export const Session: ISessionModel =
  (mongoose.models[ModelName] as unknown as ISessionModel) ?? model<ISession, ISessionModel>(ModelName, SessionSchema);
export default Session;

export const sessionRepository = new SessionRepository(Session, {
  shareable: new ShareableDocumentRepository(Session),
  questModel: QuestModel as Model<unknown>,
});
