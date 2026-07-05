import {
  IQuestMasterPlan,
  IQuestMasterPlanDocument,
  IQuestMasterPlanRepository,
  QuestMasterData,
  QuestBlocker,
  QuestDecision,
  QuestHandoff,
} from '@bike4mind/common';
import mongoose, { Model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { softDeletePlugin } from '../../utils/mongo';

// Valid status values for subquests
const SUBQUEST_STATUS_VALUES = ['not_started', 'in_progress', 'completed', 'skipped', 'deleted'] as const;

// Valid review gate status values
const REVIEW_GATE_STATUS_VALUES = ['pending', 'approved', 'rejected'] as const;

export const QuestMasterDataSchema = new Schema<QuestMasterData>(
  {
    id: { type: String, required: true },
    title: { type: String, required: true, maxlength: 500 },
    description: { type: String, required: true, maxlength: 2000 },
    complexity: { type: String, required: true },
    subQuests: {
      type: [
        {
          id: { type: String, required: true },
          title: { type: String, required: true, maxlength: 500 },
          status: {
            type: String,
            required: true,
            enum: SUBQUEST_STATUS_VALUES,
            default: 'not_started',
          },
          questId: { type: String, required: false },
          startedAt: { type: Number, required: false },
          evidence: { type: String, required: false, maxlength: 5000 },
          reviewGate: { type: Boolean, required: false, default: false },
          reviewStatus: {
            type: String,
            required: false,
            enum: REVIEW_GATE_STATUS_VALUES,
          },
          reviewNote: { type: String, required: false, maxlength: 2000 },
        },
      ],
      required: true,
      validate: {
        validator: (v: unknown[]) => v.length <= 50,
        message: 'A quest cannot have more than 50 subquests',
      },
    },
  },
  { _id: false }
);

export const QuestMasterPlanSchema = new Schema<IQuestMasterPlan>(
  {
    notebookId: { type: String, required: true },
    goal: { type: String, required: true, maxlength: 2000 },
    quests: {
      type: [QuestMasterDataSchema],
      required: true,
      validate: {
        validator: (v: unknown[]) => v.length <= 100,
        message: 'A plan cannot have more than 100 quests',
      },
    },

    // New fields for cross-session persistence
    userId: { type: String, required: false },
    visibility: {
      type: String,
      enum: ['session', 'user', 'team', 'public'],
      default: 'session',
    },
    state: {
      type: String,
      enum: ['draft', 'active', 'paused', 'completed', 'archived'],
      default: 'active',
    },
    lastAccessedAt: { type: Date, default: Date.now },

    sessionHistory: [
      {
        sessionId: { type: String, required: true },
        lastAccessed: { type: Date, required: true },
        actions: { type: Number, default: 0 },
      },
    ],

    metrics: {
      totalTimeSpent: { type: Number, default: 0, min: 0 },
      completionRate: { type: Number, default: 0, min: 0, max: 100 },
      subQuestsCompleted: { type: Number, default: 0, min: 0 },
      subQuestsTotal: { type: Number, default: 0, min: 0 },
      lastProgress: { type: Date, required: false },
    },

    tags: {
      type: [{ type: String, maxlength: 50 }],
      validate: {
        validator: (v: unknown[]) => v.length <= 20,
        message: 'A plan cannot have more than 20 tags',
      },
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      required: false,
    },
    parentPlanId: { type: String, required: false },
    sharedWith: {
      type: [{ type: String }],
      validate: {
        validator: (v: unknown[]) => v.length <= 50,
        message: 'A plan cannot be shared with more than 50 users',
      },
    },

    // Durable workflow state (inspired by Q's agentic patterns)
    handoff: {
      type: new Schema<QuestHandoff>(
        {
          summary: { type: String, required: true, maxlength: 5000 },
          nextSteps: { type: [{ type: String, maxlength: 1000 }], required: true },
          pendingDecisions: { type: [{ type: String, maxlength: 1000 }], required: true },
          blockers: { type: [{ type: String, maxlength: 1000 }], required: true },
          lastUpdatedBy: { type: String, required: true },
          updatedAt: { type: Date, required: true },
        },
        { _id: false }
      ),
      required: false,
    },

    blockers: {
      type: [
        new Schema<QuestBlocker>(
          {
            id: { type: String, required: true },
            description: { type: String, required: true, maxlength: 2000 },
            relatedQuestId: { type: String, required: false },
            relatedSubQuestId: { type: String, required: false },
            createdAt: { type: Date, required: true },
            resolvedAt: { type: Date, required: false },
            resolution: { type: String, required: false, maxlength: 2000 },
          },
          { _id: false }
        ),
      ],
      validate: {
        validator: (v: unknown[]) => v.length <= 100,
        message: 'A plan cannot have more than 100 blockers',
      },
    },

    decisions: {
      type: [
        new Schema<QuestDecision>(
          {
            id: { type: String, required: true },
            description: { type: String, required: true, maxlength: 2000 },
            rationale: { type: String, required: true, maxlength: 5000 },
            madeBy: { type: String, required: true },
            madeAt: { type: Date, required: true },
            relatedQuestId: { type: String, required: false },
            relatedSubQuestId: { type: String, required: false },
          },
          { _id: false }
        ),
      ],
      validate: {
        validator: (v: unknown[]) => v.length <= 200,
        message: 'A plan cannot have more than 200 decisions',
      },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Update indexes for better query performance
QuestMasterPlanSchema.index({ notebookId: 1 });
QuestMasterPlanSchema.index({ userId: 1 }); // Standalone index for $or query optimization
QuestMasterPlanSchema.index({ userId: 1, state: 1 });
QuestMasterPlanSchema.index({ userId: 1, lastAccessedAt: -1 });
QuestMasterPlanSchema.index({ userId: 1, state: 1, tags: 1 }); // Compound index for filtered queries
QuestMasterPlanSchema.index({ visibility: 1, sharedWith: 1 });
QuestMasterPlanSchema.index({ visibility: 1 }); // For efficient $or query with public plans
QuestMasterPlanSchema.index({ sharedWith: 1 }); // For querying shared plans
QuestMasterPlanSchema.index({ tags: 1 }); // For tag-based filtering
QuestMasterPlanSchema.index({ parentPlanId: 1 }); // For clone/fork relationship lookups
QuestMasterPlanSchema.index({ userId: 1, tags: 1 }); // Compound index for user + tags filtering
// deletedAt index is created by softDeletePlugin - do not add duplicate here

// Apply soft delete plugin for data safety
QuestMasterPlanSchema.plugin(softDeletePlugin);

export const QuestMasterPlan =
  mongoose.models.QuestMasterPlan ?? mongoose.model('QuestMasterPlan', QuestMasterPlanSchema);

class QuestMasterPlanRepository extends BaseRepository<IQuestMasterPlanDocument> implements IQuestMasterPlanRepository {
  constructor(private questMasterPlanModel: Model<IQuestMasterPlanDocument>) {
    super(questMasterPlanModel);
  }

  /**
   * Schedule a fire-and-forget metrics update.
   * Frontend receives updates via WebSocket, so we don't need to block on this.
   */
  private scheduleMetricsUpdate(planId: string): void {
    this.updateMetrics(planId).catch(err => {
      // Log with structured format for easier debugging
      console.warn('[QuestMasterPlan] Metrics update failed', { planId, error: err.message });
    });
  }

  async findByNotebookId(notebookId: string): Promise<IQuestMasterPlanDocument[]> {
    // Explicit deletedAt filter ensures soft-deleted documents are excluded
    return this.questMasterPlanModel.find({ notebookId, deletedAt: null });
  }

  async getSubQuest(
    questMasterPlanId: string,
    mainQuestId: string,
    subQuestId: string
  ): Promise<QuestMasterData['subQuests'][number] | null> {
    // Use MongoDB aggregation to retrieve only the specific subquest
    // instead of loading the entire document (which can be large with 100 quests x 50 subquests)
    const result = await this.questMasterPlanModel.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(questMasterPlanId), deletedAt: null } },
      { $unwind: '$quests' },
      { $match: { 'quests.id': mainQuestId } },
      { $unwind: '$quests.subQuests' },
      { $match: { 'quests.subQuests.id': subQuestId } },
      { $replaceRoot: { newRoot: '$quests.subQuests' } },
      { $limit: 1 },
    ]);

    return result.length > 0 ? result[0] : null;
  }

  async updateTaskStatus(
    questMasterPlanId: string,
    mainQuestId: string,
    subQuestId: string,
    status: QuestMasterData['subQuests'][number]['status']
  ): Promise<IQuestMasterPlanDocument | null> {
    // Use atomic update with arrayFilters to prevent race conditions
    // This still triggers MongoDB change streams for real-time sync
    const result = await this.questMasterPlanModel.findOneAndUpdate(
      {
        _id: questMasterPlanId,
        'quests.id': mainQuestId,
        'quests.subQuests.id': subQuestId,
      },
      {
        $set: {
          'quests.$[quest].subQuests.$[subQuest].status': status,
        },
      },
      {
        arrayFilters: [{ 'quest.id': mainQuestId }, { 'subQuest.id': subQuestId }],
        new: true,
      }
    );

    if (!result) {
      return null;
    }

    this.scheduleMetricsUpdate(questMasterPlanId);
    return result;
  }

  // Maximum default limit for queries to prevent unbounded results
  private static readonly DEFAULT_QUERY_LIMIT = 100;

  // Fields to exclude when listing plans (large nested arrays)
  private static readonly LIST_PROJECTION = {
    quests: 0, // Exclude large quests array for list queries
    sessionHistory: 0, // Exclude session history for list queries
  };

  // New methods for cross-session persistence
  async findByUserId(
    userId: string,
    options?: {
      state?: string;
      tags?: string[];
      limit?: number;
      offset?: number;
      includeQuests?: boolean; // Set to true to include full quests array
    }
  ): Promise<IQuestMasterPlanDocument[]> {
    const query: Record<string, unknown> = {
      $or: [{ userId }, { sharedWith: userId }],
      // Explicit deletedAt filter ensures soft-deleted documents are excluded
      deletedAt: null,
    };

    if (options?.state) {
      query.state = options.state;
    }

    if (options?.tags?.length) {
      query.tags = { $in: options.tags };
    }

    // Use projection to exclude large arrays unless explicitly requested
    const projection = options?.includeQuests ? {} : QuestMasterPlanRepository.LIST_PROJECTION;

    return this.questMasterPlanModel
      .find(query, projection)
      .sort({ lastAccessedAt: -1 })
      .limit(options?.limit || QuestMasterPlanRepository.DEFAULT_QUERY_LIMIT)
      .skip(options?.offset || 0);
  }

  // Optimized method that returns plans, total count, and stats in efficient queries
  async findByUserIdWithCount(
    userId: string,
    options?: {
      state?: string;
      tags?: string[];
      limit?: number;
      offset?: number;
      includeQuests?: boolean; // Set to true to include full quests array
    }
  ): Promise<{
    plans: IQuestMasterPlanDocument[];
    total: number;
    stats: { active: number; paused: number; completed: number; archived: number; totalTimeSpent: number };
  }> {
    const baseQuery: Record<string, unknown> = {
      $or: [{ userId }, { sharedWith: userId }],
      // Explicit deletedAt filter ensures soft-deleted documents are excluded
      deletedAt: null,
    };

    const filteredQuery: Record<string, unknown> = { ...baseQuery };

    if (options?.state) {
      filteredQuery.state = options.state;
    }

    if (options?.tags?.length) {
      filteredQuery.tags = { $in: options.tags };
    }

    // Use projection to exclude large arrays unless explicitly requested
    const projection = options?.includeQuests ? {} : QuestMasterPlanRepository.LIST_PROJECTION;

    // Execute all queries in parallel for efficiency
    const [plans, total, statsResult] = await Promise.all([
      this.questMasterPlanModel
        .find(filteredQuery, projection)
        .sort({ lastAccessedAt: -1 })
        .limit(options?.limit || QuestMasterPlanRepository.DEFAULT_QUERY_LIMIT)
        .skip(options?.offset || 0),
      this.questMasterPlanModel.countDocuments(filteredQuery),
      // Aggregate stats across ALL user's plans (not filtered by state)
      this.questMasterPlanModel.aggregate([
        { $match: baseQuery },
        {
          $group: {
            _id: '$state',
            count: { $sum: 1 },
            totalTime: { $sum: { $ifNull: ['$metrics.totalTimeSpent', 0] } },
          },
        },
      ]),
    ]);

    // Transform aggregation result into stats object
    const stats = {
      active: 0,
      paused: 0,
      completed: 0,
      archived: 0,
      totalTimeSpent: 0,
    };

    for (const item of statsResult) {
      if (item._id === 'active') stats.active = item.count;
      else if (item._id === 'paused') stats.paused = item.count;
      else if (item._id === 'completed') stats.completed = item.count;
      else if (item._id === 'archived') stats.archived = item.count;
      stats.totalTimeSpent += item.totalTime;
    }

    return { plans, total, stats };
  }

  async findAccessibleByUserId(
    userId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<IQuestMasterPlanDocument[]> {
    return this.questMasterPlanModel
      .find({
        $or: [{ userId }, { sharedWith: userId }, { visibility: 'public' }],
        // Explicit deletedAt filter ensures soft-deleted documents are excluded
        deletedAt: null,
      })
      .sort({ lastAccessedAt: -1 })
      .limit(options?.limit || QuestMasterPlanRepository.DEFAULT_QUERY_LIMIT)
      .skip(options?.offset || 0);
  }

  // Maximum number of session history entries to keep (prevent unbounded growth)
  private static readonly MAX_SESSION_HISTORY_ENTRIES = 50;

  // Valid state transitions map
  private static readonly VALID_STATE_TRANSITIONS: Record<string, string[]> = {
    draft: ['active', 'archived'],
    active: ['paused', 'completed', 'archived'],
    paused: ['active', 'completed', 'archived'],
    completed: ['archived'], // Completed quests can only be archived, not reactivated
    archived: [], // Terminal state - no transitions allowed
  };

  /**
   * Validates if a state transition is allowed
   * @returns true if transition is valid, false otherwise
   */
  isValidStateTransition(fromState: string, toState: string): boolean {
    const allowedTransitions = QuestMasterPlanRepository.VALID_STATE_TRANSITIONS[fromState];
    if (!allowedTransitions) {
      return false; // Unknown source state
    }
    return allowedTransitions.includes(toState);
  }

  async continueInSession(planId: string, sessionId: string, userId: string): Promise<IQuestMasterPlanDocument> {
    // First, verify plan exists and check access (still needs a read)
    const plan = await this.findById(planId);
    if (!plan) {
      throw new Error('Quest plan not found');
    }

    // Check access - only owner and explicitly shared users can continue a plan
    // Public plans are read-only (viewing only, no session continuation)
    if (plan.userId !== userId && !plan.sharedWith?.includes(userId)) {
      throw new Error('Access denied');
    }

    // Try to increment existing session entry atomically
    // This prevents race conditions when multiple requests hit concurrently
    const existingResult = await this.questMasterPlanModel.findOneAndUpdate(
      { _id: planId, 'sessionHistory.sessionId': sessionId },
      {
        $set: {
          'sessionHistory.$.lastAccessed': new Date(),
          lastAccessedAt: new Date(),
        },
        $inc: { 'sessionHistory.$.actions': 1 },
      },
      { new: true }
    );

    if (existingResult) {
      return existingResult;
    }

    // Session doesn't exist in history - add new entry with cap enforcement
    // Using $slice to keep only the most recent entries (negative value keeps last N)
    const result = await this.questMasterPlanModel.findByIdAndUpdate(
      planId,
      {
        $push: {
          sessionHistory: {
            $each: [{ sessionId, lastAccessed: new Date(), actions: 1 }],
            $slice: -QuestMasterPlanRepository.MAX_SESSION_HISTORY_ENTRIES,
          },
        },
        $set: { lastAccessedAt: new Date() },
      },
      { new: true }
    );

    if (!result) {
      throw new Error('Failed to update quest plan');
    }

    return result;
  }

  // Valid status values for runtime validation
  private static readonly VALID_SUBQUEST_STATUSES = [
    'not_started',
    'in_progress',
    'completed',
    'skipped',
    'deleted',
  ] as const;

  async updateQuestProgress(
    planId: string,
    questId: string,
    subQuestId: string,
    updates: {
      status?: 'not_started' | 'in_progress' | 'completed' | 'skipped' | 'deleted';
      timeSpent?: number;
      chatMessageId?: string;
      startedAt?: number;
      evidence?: string;
    },
    options?: {
      autoResumeIfPaused?: boolean;
    }
  ): Promise<IQuestMasterPlanDocument | null> {
    // Runtime validation for updates
    if (updates.status && !QuestMasterPlanRepository.VALID_SUBQUEST_STATUSES.includes(updates.status)) {
      throw new Error(`Invalid status: ${updates.status}`);
    }

    if (updates.timeSpent !== undefined) {
      if (typeof updates.timeSpent !== 'number' || updates.timeSpent < 0 || !Number.isFinite(updates.timeSpent)) {
        throw new Error('timeSpent must be a non-negative finite number');
      }
    }

    if (updates.startedAt !== undefined) {
      if (typeof updates.startedAt !== 'number' || updates.startedAt < 0 || !Number.isFinite(updates.startedAt)) {
        throw new Error('startedAt must be a non-negative finite number (timestamp)');
      }
    }

    // Build atomic $set operations for sub-quest fields
    const subQuestUpdates: Record<string, unknown> = {};

    if (updates.status) {
      subQuestUpdates['quests.$[quest].subQuests.$[subQuest].status'] = updates.status;
    }

    if (updates.chatMessageId) {
      subQuestUpdates['quests.$[quest].subQuests.$[subQuest].questId'] = updates.chatMessageId;
    }

    if (updates.startedAt) {
      subQuestUpdates['quests.$[quest].subQuests.$[subQuest].startedAt'] = updates.startedAt;
    }

    if (updates.evidence) {
      subQuestUpdates['quests.$[quest].subQuests.$[subQuest].evidence'] = updates.evidence;
    }

    // Build update operation - only include $set if there are subquest updates
    const updateOp: Record<string, unknown> = {};
    if (Object.keys(subQuestUpdates).length > 0) {
      updateOp.$set = subQuestUpdates;
    }

    // Handle time tracking with $inc for atomic increment
    if (updates.timeSpent) {
      updateOp.$inc = { 'metrics.totalTimeSpent': updates.timeSpent };
      // Also update lastProgress timestamp
      updateOp.$set = {
        ...(updateOp.$set as Record<string, unknown>),
        'metrics.lastProgress': new Date(),
      };
    }

    // Only proceed with update if there are changes
    if (Object.keys(updateOp).length === 0) {
      return this.findById(planId);
    }

    // Build query - optionally include auto-resume logic for paused plans
    const query: Record<string, unknown> = {
      _id: planId,
      'quests.id': questId,
      'quests.subQuests.id': subQuestId,
    };

    // If auto-resume is enabled and we're starting work, include state update in the same atomic operation
    if (options?.autoResumeIfPaused && updates.status === 'in_progress') {
      // Use conditional update: only change state if it's 'paused'
      // This avoids a separate read-then-write operation
      updateOp.$set = {
        ...(updateOp.$set as Record<string, unknown>),
      };

      // We need to do this in two steps for conditional state update,
      // but we can optimize by first trying to update paused plans
      const pausedResult = await this.questMasterPlanModel.findOneAndUpdate(
        { ...query, state: 'paused' },
        { ...updateOp, $set: { ...(updateOp.$set as Record<string, unknown>), state: 'active' } },
        {
          arrayFilters: [{ 'quest.id': questId }, { 'subQuest.id': subQuestId }],
          new: true,
        }
      );

      if (pausedResult) {
        this.scheduleMetricsUpdate(planId);
        return pausedResult;
      }
      // Fall through to regular update if not paused
    }

    // Use atomic update with arrayFilters to prevent race conditions
    const result = await this.questMasterPlanModel.findOneAndUpdate(query, updateOp, {
      arrayFilters: [{ 'quest.id': questId }, { 'subQuest.id': subQuestId }],
      new: true,
    });

    if (!result) {
      throw new Error('Quest plan or sub-quest not found');
    }

    this.scheduleMetricsUpdate(planId);
    return result;
  }

  /**
   * Atomically updates notebookId only if it matches the expected value
   * This prevents race conditions when multiple requests try to create sessions
   * @returns true if update succeeded, false if notebookId was already changed
   */
  async atomicUpdateNotebookId(planId: string, expectedNotebookId: string, newNotebookId: string): Promise<boolean> {
    const result = await this.questMasterPlanModel.findOneAndUpdate(
      { _id: planId, notebookId: expectedNotebookId },
      { $set: { notebookId: newNotebookId } },
      { new: true }
    );
    return result !== null;
  }

  async updateMetrics(planId: string): Promise<IQuestMasterPlanDocument | null> {
    // Use aggregation pipeline to calculate metrics without loading full document
    // This is much more efficient for plans with 100 quests x 50 subquests
    const statsResult = await this.questMasterPlanModel.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(planId), deletedAt: null } },
      { $unwind: { path: '$quests', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$quests.subQuests', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: '$_id',
          state: { $first: '$state' },
          totalSubQuests: { $sum: { $cond: [{ $ifNull: ['$quests.subQuests', false] }, 1, 0] } },
          completedSubQuests: {
            $sum: { $cond: [{ $eq: ['$quests.subQuests.status', 'completed'] }, 1, 0] },
          },
        },
      },
    ]);

    if (statsResult.length === 0) {
      throw new Error(`Quest plan not found: ${planId}`);
    }

    const stats = statsResult[0];
    const completionRate =
      stats.totalSubQuests > 0 ? Math.round((stats.completedSubQuests / stats.totalSubQuests) * 100) : 0;

    // Build update operation
    const updateOp: Record<string, unknown> = {
      $set: {
        'metrics.subQuestsTotal': stats.totalSubQuests,
        'metrics.subQuestsCompleted': stats.completedSubQuests,
        'metrics.completionRate': completionRate,
      },
    };

    // Auto-complete if 100% and currently active or paused
    if (completionRate === 100 && (stats.state === 'active' || stats.state === 'paused')) {
      (updateOp.$set as Record<string, unknown>)['state'] = 'completed';
    }

    // Perform atomic update and return the updated document
    // This eliminates the need for a separate findById() call after metrics update
    return this.questMasterPlanModel.findByIdAndUpdate(planId, updateOp, { new: true });
  }

  async updateHandoff(planId: string, handoff: QuestHandoff): Promise<IQuestMasterPlanDocument | null> {
    return this.questMasterPlanModel.findByIdAndUpdate(planId, { $set: { handoff } }, { new: true });
  }

  async addBlocker(planId: string, blocker: QuestBlocker): Promise<IQuestMasterPlanDocument | null> {
    return this.questMasterPlanModel.findByIdAndUpdate(
      planId,
      {
        $push: {
          blockers: {
            $each: [blocker],
            $slice: -100, // Keep max 100 blockers
          },
        },
      },
      { new: true }
    );
  }

  async resolveBlocker(
    planId: string,
    blockerId: string,
    resolution: string
  ): Promise<IQuestMasterPlanDocument | null> {
    return this.questMasterPlanModel.findOneAndUpdate(
      { _id: planId, 'blockers.id': blockerId },
      {
        $set: {
          'blockers.$.resolvedAt': new Date(),
          'blockers.$.resolution': resolution,
        },
      },
      { new: true }
    );
  }

  async addDecision(planId: string, decision: QuestDecision): Promise<IQuestMasterPlanDocument | null> {
    return this.questMasterPlanModel.findByIdAndUpdate(
      planId,
      {
        $push: {
          decisions: {
            $each: [decision],
            $slice: -200, // Keep max 200 decisions
          },
        },
      },
      { new: true }
    );
  }

  async updateReviewGate(
    planId: string,
    questId: string,
    subQuestId: string,
    reviewStatus: 'pending' | 'approved' | 'rejected',
    reviewNote?: string
  ): Promise<IQuestMasterPlanDocument | null> {
    const setFields: Record<string, unknown> = {
      'quests.$[quest].subQuests.$[subQuest].reviewStatus': reviewStatus,
    };

    if (reviewNote !== undefined) {
      setFields['quests.$[quest].subQuests.$[subQuest].reviewNote'] = reviewNote;
    }

    return this.questMasterPlanModel.findOneAndUpdate(
      {
        _id: planId,
        'quests.id': questId,
        'quests.subQuests.id': subQuestId,
      },
      { $set: setFields },
      {
        arrayFilters: [{ 'quest.id': questId }, { 'subQuest.id': subQuestId }],
        new: true,
      }
    );
  }
}

export const questMasterPlanRepository = new QuestMasterPlanRepository(QuestMasterPlan);
