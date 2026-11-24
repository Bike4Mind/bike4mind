import mongoose, { Schema } from 'mongoose';
import type { BriefItem, BriefSourceRef, BriefStatus, StoredBriefDecision } from '@bike4mind/common';

/**
 * An assistant brief: what happened, what was handled and what needs a decision, composed for one user
 * by apps/workers/src/events/briefCompose.ts. The wire shape is `BriefSchema` in @bike4mind/common.
 */
export type IAssistantBrief = {
  _id: mongoose.Types.ObjectId;
  userId: string;
  status: BriefStatus;
  periodStart: Date;
  periodEnd: Date;
  headline: string | null;
  happened: BriefItem[];
  handled: BriefItem[];
  decisions: StoredBriefDecision[];
  composedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AssistantBriefContent = Pick<IAssistantBrief, 'headline' | 'happened' | 'handled' | 'decisions'>;

function requiredFor(kind: BriefSourceRef['kind']) {
  return function (this: { kind?: string }) {
    return this.kind === kind;
  };
}

// Every field of the wire item must be declared here: strict mode drops undeclared keys on write.
const sourceSchema = new Schema(
  {
    kind: { type: String, enum: ['email', 'delegation'], required: true },
    emailId: { type: String, required: requiredFor('email') },
    delegationId: { type: String, required: requiredFor('delegation') },
  },
  { _id: false }
);
const itemSchema = new Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    source: { type: sourceSchema, required: false },
  },
  { _id: false }
);
const decisionSchema = new Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    source: { type: sourceSchema, required: false },
    draftReply: {
      type: new Schema(
        {
          to: { type: String, required: true },
          subject: { type: String, required: true },
          body: { type: String, required: true },
        },
        { _id: false }
      ),
      required: false,
    },
    approval: {
      type: new Schema(
        {
          questId: { type: String, required: true },
          sessionId: { type: String, required: true },
          pendingActionTs: { type: Number, required: true },
        },
        { _id: false }
      ),
      required: false,
    },
    question: {
      type: new Schema(
        {
          questId: { type: String, required: true },
          sessionId: { type: String, required: true },
          options: { type: [String], default: [] },
        },
        { _id: false }
      ),
      required: false,
    },
    repliedAt: { type: Date, required: false },
  },
  { _id: false }
);

const schema = new Schema<IAssistantBrief>(
  {
    userId: { type: String, required: true },
    status: { type: String, enum: ['composing', 'ready', 'failed'], required: true, default: 'composing' },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    headline: { type: String, default: null },
    happened: { type: [itemSchema], default: [] },
    handled: { type: [itemSchema], default: [] },
    decisions: { type: [decisionSchema], default: [] },
    composedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'AssistantBrief' }
);

schema.index({ userId: 1, createdAt: -1 });

export const AssistantBriefModel =
  (mongoose.models.AssistantBrief as mongoose.Model<IAssistantBrief> | undefined) ??
  mongoose.model<IAssistantBrief>('AssistantBrief', schema);

/** A brief still composing after this long is treated as abandoned, so a lost event cannot block composing for good. */
export const BRIEF_COMPOSING_STALE_MS = 5 * 60 * 1000;

export const assistantBriefRepository = {
  async createComposing(input: { userId: string; periodStart: Date; periodEnd: Date }): Promise<IAssistantBrief> {
    const created = await AssistantBriefModel.create({ ...input, status: 'composing' });
    return created.toObject();
  },

  /** The user's in-flight brief, if one was started recently enough to still be composing. */
  async findActiveComposing(userId: string, now: Date = new Date()): Promise<IAssistantBrief | null> {
    return AssistantBriefModel.findOne({
      userId,
      status: 'composing',
      createdAt: { $gt: new Date(now.getTime() - BRIEF_COMPOSING_STALE_MS) },
    })
      .sort({ createdAt: -1 })
      .lean();
  },

  /** Scoped to the owner: another user's id reads as missing. A malformed id is missing too. */
  async findByIdForUser(id: string, userId: string): Promise<IAssistantBrief | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    return AssistantBriefModel.findOne({ _id: id, userId }).lean();
  },

  async listByUser(userId: string, limit: number): Promise<IAssistantBrief[]> {
    return AssistantBriefModel.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();
  },

  /** The end of the previous brief's window, which the next brief starts from. */
  async findLatestReady(userId: string): Promise<IAssistantBrief | null> {
    return AssistantBriefModel.findOne({ userId, status: 'ready' }).sort({ createdAt: -1 }).lean();
  },

  /** The latest ready brief's id and each decision's approval ref and reply stamp: what the pending-decisions count reads. */
  async findLatestReadyDecisionRefs(userId: string): Promise<{
    _id: mongoose.Types.ObjectId;
    decisions: Array<Pick<StoredBriefDecision, 'approval' | 'repliedAt'>>;
  } | null> {
    return AssistantBriefModel.findOne({ userId, status: 'ready' })
      .sort({ createdAt: -1 })
      .select('_id decisions.approval decisions.repliedAt')
      .lean();
  },

  /** Only a `composing` brief can be settled, so a redelivered event never overwrites a finished one. */
  async markReady(id: string, content: AssistantBriefContent, composedAt: Date): Promise<boolean> {
    const result = await AssistantBriefModel.updateOne(
      { _id: id, status: 'composing' },
      { $set: { ...content, status: 'ready', composedAt } },
      { runValidators: true }
    );
    return result.modifiedCount === 1;
  },

  async markFailed(id: string, failureReason: string): Promise<boolean> {
    const result = await AssistantBriefModel.updateOne(
      { _id: id, status: 'composing' },
      { $set: { status: 'failed', failureReason } },
      { runValidators: true }
    );
    return result.modifiedCount === 1;
  },

  /** Drops a brief that is still composing; a settled one is left alone. */
  async discardComposing(id: string): Promise<boolean> {
    const result = await AssistantBriefModel.deleteOne({ _id: id, status: 'composing' });
    return result.deletedCount === 1;
  },

  /**
   * Marks a question decision replied, once: only the first caller gets `true`, so a double tap or a
   * replay sends the reply to the agent at most once. Scoped to the owner like `findByIdForUser`.
   */
  async claimDecisionReply(id: string, userId: string, decisionId: string, at: Date = new Date()): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await AssistantBriefModel.updateOne(
      { _id: id, userId, decisions: { $elemMatch: { id: decisionId, question: { $exists: true }, repliedAt: null } } },
      { $set: { 'decisions.$.repliedAt': at } },
      { runValidators: true }
    );
    return result.modifiedCount === 1;
  },

  /** Undoes a claim whose reply never reached the agent, so the user can try again. */
  async releaseDecisionReply(id: string, userId: string, decisionId: string, at: Date): Promise<void> {
    await AssistantBriefModel.updateOne(
      { _id: id, userId, decisions: { $elemMatch: { id: decisionId, repliedAt: at } } },
      { $unset: { 'decisions.$.repliedAt': 1 } },
      { runValidators: true }
    );
  },

  /** Removes the items sourced from these ingested emails from every brief of the owner, so a deleted email leaves no copy behind. */
  async removeEmailSourcedItems(userId: string, emailIds: string[]): Promise<number> {
    if (emailIds.length === 0) return 0;
    const fromEmails = { 'source.emailId': { $in: emailIds } };
    const result = await AssistantBriefModel.updateMany(
      {
        userId,
        $or: [
          { 'happened.source.emailId': { $in: emailIds } },
          { 'handled.source.emailId': { $in: emailIds } },
          { 'decisions.source.emailId': { $in: emailIds } },
        ],
      },
      { $pull: { happened: fromEmails, handled: fromEmails, decisions: fromEmails } },
      { runValidators: true }
    );
    return result.modifiedCount;
  },

  async findById(id: string): Promise<IAssistantBrief | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    return AssistantBriefModel.findById(id).lean();
  },
};
