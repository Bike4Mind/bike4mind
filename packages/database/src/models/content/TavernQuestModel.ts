import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'TavernQuest';

export interface ITavernQuestDoc {
  _id: string;
  title: string;
  description: string;
  postedByAgentId: string;
  postedByAgentName: string;
  claimedByAgentId?: string;
  claimedByAgentName?: string;
  status: 'open' | 'claimed' | 'completed' | 'expired';
  reward?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  userId: string;
  createdAt: Date;
  claimedAt?: Date;
  completedAt?: Date;
  completionNote?: string;
  /** When this quest expires (defaults to 24h from creation) */
  expiresAt?: Date;
  /** Parent quest ID - makes this a sub-quest */
  parentQuestId?: string;
  /** Execution order within parent (1-based) */
  order?: number;
}

interface ITavernQuestModel extends Model<ITavernQuestDoc> {}

const TavernQuestSchema = new Schema<ITavernQuestDoc>(
  {
    title: { type: String, required: true },
    description: { type: String, required: true },
    postedByAgentId: { type: String, required: true },
    postedByAgentName: { type: String, required: true },
    claimedByAgentId: { type: String },
    claimedByAgentName: { type: String },
    status: {
      type: String,
      enum: ['open', 'claimed', 'completed', 'expired'],
      default: 'open',
    },
    reward: { type: String },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'] },
    userId: { type: String, required: true },
    claimedAt: { type: Date },
    completedAt: { type: Date },
    completionNote: { type: String },
    expiresAt: { type: Date },
    parentQuestId: { type: String },
    order: { type: Number },
  },
  { timestamps: true }
);

// Performance indexes
TavernQuestSchema.index({ userId: 1, status: 1 });
TavernQuestSchema.index({ userId: 1, createdAt: -1 });
TavernQuestSchema.index({ parentQuestId: 1, order: 1 });
TavernQuestSchema.index({ status: 1, expiresAt: 1 });

export const TavernQuest: ITavernQuestModel =
  (mongoose.models[ModelName] as ITavernQuestModel) ||
  model<ITavernQuestDoc, ITavernQuestModel>(ModelName, TavernQuestSchema);

// ---------------------------------------------------------------------------
// Repository-style helper functions (no class needed for this lightweight model)
// ---------------------------------------------------------------------------

export const tavernQuestRepository = {
  /** Get all open quests for a user's tavern */
  async getOpenQuests(userId: string): Promise<ITavernQuestDoc[]> {
    return TavernQuest.find({ userId, status: 'open' }).sort({ createdAt: -1 }).limit(20).lean();
  },

  /** Get all quests for a user's tavern (any status) */
  async getAllQuests(userId: string, limit = 50): Promise<ITavernQuestDoc[]> {
    return TavernQuest.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();
  },

  /** Get a single quest by ID, scoped to user */
  async getUserQuestById(questId: string, userId: string): Promise<ITavernQuestDoc | null> {
    return TavernQuest.findOne({ _id: questId, userId }).lean();
  },

  /** Post a new quest */
  async postQuest(quest: Omit<ITavernQuestDoc, '_id' | 'createdAt' | 'status'>): Promise<ITavernQuestDoc> {
    const expiresAt = quest.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
    const doc = await TavernQuest.create({ ...quest, status: 'open', expiresAt });
    return doc.toObject();
  },

  /** Claim a quest */
  async claimQuest(questId: string, agentId: string, agentName: string): Promise<ITavernQuestDoc | null> {
    return TavernQuest.findOneAndUpdate(
      { _id: questId, status: 'open' },
      {
        $set: {
          claimedByAgentId: agentId,
          claimedByAgentName: agentName,
          status: 'claimed',
          claimedAt: new Date(),
        },
      },
      { new: true }
    ).lean();
  },

  /** Complete a quest */
  async completeQuest(questId: string, agentId: string, completionNote?: string): Promise<ITavernQuestDoc | null> {
    return TavernQuest.findOneAndUpdate(
      { _id: questId, claimedByAgentId: agentId, status: 'claimed' },
      {
        $set: {
          status: 'completed',
          completedAt: new Date(),
          completionNote,
        },
      },
      { new: true }
    ).lean();
  },

  /** Update an open quest (only editable fields, only open status) */
  async updateQuest(
    questId: string,
    userId: string,
    updates: Partial<Pick<ITavernQuestDoc, 'title' | 'description' | 'difficulty' | 'reward'>>
  ): Promise<ITavernQuestDoc | null> {
    return TavernQuest.findOneAndUpdate(
      { _id: questId, userId, status: 'open' },
      { $set: updates },
      { new: true }
    ).lean();
  },

  /** Unclaim a quest - resets a claimed quest back to open */
  async unclaimQuest(questId: string, userId: string): Promise<ITavernQuestDoc | null> {
    return TavernQuest.findOneAndUpdate(
      { _id: questId, userId, status: 'claimed' },
      { $set: { status: 'open' }, $unset: { claimedByAgentId: 1, claimedByAgentName: 1, claimedAt: 1 } },
      { new: true }
    ).lean();
  },

  /** Release any quest claimed by `agentId` whose `claimedAt` is older than
   *  `staleAfterMs`. Returns the titles of released quests so the heartbeat can
   *  log them. Used to break "claimed forever, never delivered" loops without
   *  requiring user intervention. */
  async releaseStaleClaimsByAgent(agentId: string, staleAfterMs: number): Promise<{ id: string; title: string }[]> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const stale = await TavernQuest.find(
      { claimedByAgentId: agentId, status: 'claimed', claimedAt: { $lt: cutoff } },
      { _id: 1, title: 1 }
    ).lean();
    if (stale.length === 0) return [];
    await TavernQuest.updateMany(
      { claimedByAgentId: agentId, status: 'claimed', claimedAt: { $lt: cutoff } },
      { $set: { status: 'open' }, $unset: { claimedByAgentId: 1, claimedByAgentName: 1, claimedAt: 1 } }
    );
    return stale.map(q => ({ id: (q._id as { toString(): string }).toString(), title: q.title }));
  },

  /** Delete a quest and its sub-quests (cascade delete) */
  async deleteQuest(questId: string, userId: string): Promise<boolean> {
    // Verify ownership before deleting anything
    const quest = await TavernQuest.findOne({ _id: questId, userId }, { _id: 1 }).lean();
    if (!quest) return false;

    // Delete children first, then parent. If the process crashes between
    // the two operations, we're left with a parent that has no children
    // (harmless) rather than children with no parent (orphans).
    await TavernQuest.deleteMany({ parentQuestId: questId });
    await TavernQuest.deleteOne({ _id: questId });
    return true;
  },

  /** Count open quests for a user */
  async countOpen(userId: string): Promise<number> {
    return TavernQuest.countDocuments({ userId, status: 'open' });
  },

  /** Get sub-quests of a parent quest, ordered by `order` field */
  async getSubQuests(parentQuestId: string): Promise<ITavernQuestDoc[]> {
    return TavernQuest.find({ parentQuestId }).sort({ order: 1 }).lean();
  },

  /** Get the next uncompleted sub-quest for a parent */
  async getNextSubQuest(parentQuestId: string): Promise<ITavernQuestDoc | null> {
    return TavernQuest.findOne({
      parentQuestId,
      status: { $in: ['open', 'claimed'] },
    })
      .sort({ order: 1 })
      .lean();
  },

  /** Check if all sub-quests of a parent are completed */
  async areAllSubQuestsComplete(parentQuestId: string): Promise<boolean> {
    const incomplete = await TavernQuest.countDocuments({
      parentQuestId,
      status: { $ne: 'completed' },
    });
    return incomplete === 0;
  },

  /** Count sub-quest progress: { total, completed } */
  async getSubQuestProgress(parentQuestId: string): Promise<{ total: number; completed: number }> {
    const total = await TavernQuest.countDocuments({ parentQuestId });
    const completed = await TavernQuest.countDocuments({ parentQuestId, status: 'completed' });
    return { total, completed };
  },

  /** Bulk-expire open quests past their expiresAt deadline. Returns affected user IDs. */
  async expireOverdue(): Promise<string[]> {
    const now = new Date();
    // Find distinct userIds that have expirable quests before updating
    const expirableQuests = await TavernQuest.find({ status: 'open', expiresAt: { $lte: now } }, { userId: 1 }).lean();
    const affectedUserIds = Array.from(new Set(expirableQuests.map(q => q.userId)));

    if (affectedUserIds.length > 0) {
      await TavernQuest.updateMany({ status: 'open', expiresAt: { $lte: now } }, { $set: { status: 'expired' } });
    }

    return affectedUserIds;
  },

  /** Delete sub-quests whose parent quest no longer exists. Returns count of deleted orphans. */
  async deleteOrphanedSubQuests(): Promise<number> {
    // Find all distinct parentQuestIds referenced by sub-quests
    const parentIds: string[] = await TavernQuest.distinct('parentQuestId', {
      parentQuestId: { $exists: true, $ne: null },
    });

    if (parentIds.length === 0) return 0;

    // Check which of those parents still exist
    const existingParents = await TavernQuest.find({ _id: { $in: parentIds } }, { _id: 1 }).lean();
    const existingIds = new Set(existingParents.map(p => p._id.toString()));

    // Orphans = sub-quests whose parentQuestId is not in the existing set
    const orphanedParentIds = parentIds.filter(id => !existingIds.has(id));
    if (orphanedParentIds.length === 0) return 0;

    const result = await TavernQuest.deleteMany({ parentQuestId: { $in: orphanedParentIds } });
    return result.deletedCount;
  },
};
