import mongoose, { Schema } from 'mongoose';
import {
  BRIEF_FOLLOW_UP_KINDS,
  BRIEF_FOLLOW_UP_STATES,
  type BriefItem,
  type BriefSourceRef,
  type BriefStatus,
  type StoredBriefDecision,
} from '@bike4mind/common';

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
  /** Set on a brief composed when a calendar busy block ended; null for scheduled and on-demand briefs. */
  trigger?: 'busy_block' | null;
  /** The block's exact bounds; emails and questions are windowed on its start, runs on `periodStart`. */
  busyBlock?: { start: Date; end: Date } | null;
  headline: string | null;
  happened: BriefItem[];
  handled: BriefItem[];
  decisions: StoredBriefDecision[];
  composedAt: Date | null;
  failureReason: string | null;
  /** `followUp` for a brief composed from a dictated memo; absent for an activity brief. */
  origin?: 'followUp';
  /** The memo a follow-up brief is composed from; cleared once the brief settles. */
  followUpInput?: { transcript: string; timeZone?: string; expiresAt?: Date };
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
    kind: { type: String, enum: ['email', 'delegation', 'obligation'], required: true },
    emailId: { type: String, required: requiredFor('email') },
    delegationId: { type: String, required: requiredFor('delegation') },
    obligationId: { type: String, required: requiredFor('obligation') },
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
    followUp: {
      type: new Schema(
        {
          kind: { type: String, enum: BRIEF_FOLLOW_UP_KINDS, required: true },
          state: { type: String, enum: BRIEF_FOLLOW_UP_STATES, required: true, default: 'pending' },
          remindAt: { type: Date, default: null },
          decidedAt: { type: Date, required: false },
          surfacedAt: { type: Date, required: false },
        },
        { _id: false }
      ),
      required: false,
    },
  },
  { _id: false }
);

const schema = new Schema<IAssistantBrief>(
  {
    userId: { type: String, required: true },
    status: { type: String, enum: ['composing', 'ready', 'failed'], required: true, default: 'composing' },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    trigger: { type: String, enum: ['busy_block', null], default: null },
    busyBlock: {
      type: new Schema({ start: { type: Date, required: true }, end: { type: Date, required: true } }, { _id: false }),
      default: null,
    },
    headline: { type: String, default: null },
    happened: { type: [itemSchema], default: [] },
    handled: { type: [itemSchema], default: [] },
    decisions: { type: [decisionSchema], default: [] },
    composedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    origin: { type: String, enum: ['followUp'], required: false },
    followUpInput: {
      type: new Schema(
        {
          transcript: { type: String, required: true },
          timeZone: { type: String, required: false },
          // TTL: settling unsets followUpInput, so only a row whose compose event never landed is deleted.
          expiresAt: { type: Date, required: false },
        },
        { _id: false }
      ),
      required: false,
    },
  },
  { timestamps: true, versionKey: false, collection: 'AssistantBrief' }
);

schema.index({ userId: 1, createdAt: -1 });
schema.index({ 'followUpInput.expiresAt': 1 }, { expireAfterSeconds: 0 });
// Only memo briefs carry reminders; serves the due-reminder aggregates without walking every daily brief.
schema.index({ userId: 1, 'decisions.followUp.remindAt': 1 }, { partialFilterExpression: { origin: 'followUp' } });

export const AssistantBriefModel =
  (mongoose.models.AssistantBrief as mongoose.Model<IAssistantBrief> | undefined) ??
  mongoose.model<IAssistantBrief>('AssistantBrief', schema);

/** A brief still composing after this long is treated as abandoned, so a lost event cannot block composing for good. */
export const BRIEF_COMPOSING_STALE_MS = 5 * 60 * 1000;
// Busy-block briefs readied since the last regular brief that the pending-decisions count reads.
const BLOCK_BRIEFS_COUNTED_MAX = 48;

/** How long a follow-up brief may stay unsettled before its row (and the stored memo) is deleted (ms). */
export const FOLLOW_UP_COMPOSING_TTL_MS = 60 * 60 * 1000;

/** Activity briefs only: a follow-up brief neither blocks nor shifts the activity window. */
const ACTIVITY_BRIEF = { origin: { $ne: 'followUp' } } as const;

export type FollowUpDecisionEdit = {
  text?: string;
  draftReply?: Partial<{ to: string; subject: string; body: string }>;
  remindAt?: Date;
};

export type DueReminder = { briefId: string; decisionId: string; text: string; remindAt: Date };

export const assistantBriefRepository = {
  async createComposing(input: {
    userId: string;
    periodStart: Date;
    periodEnd: Date;
    origin?: 'followUp';
    followUpInput?: { transcript: string; timeZone?: string };
    trigger?: 'busy_block';
    busyBlock?: { start: Date; end: Date };
  }): Promise<IAssistantBrief> {
    const followUpInput = input.followUpInput && {
      ...input.followUpInput,
      expiresAt: new Date(Date.now() + FOLLOW_UP_COMPOSING_TTL_MS),
    };
    const created = await AssistantBriefModel.create({ ...input, followUpInput, status: 'composing' });
    return created.toObject();
  },

  /** The user's in-flight brief, if one was started recently enough to still be composing. */
  async findActiveComposing(userId: string, now: Date = new Date()): Promise<IAssistantBrief | null> {
    return AssistantBriefModel.findOne({
      userId,
      status: 'composing',
      ...ACTIVITY_BRIEF,
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

  /** Activity briefs only: clients open the newest ready one as "the" brief; a memo opens by id. */
  async listByUser(userId: string, limit: number): Promise<IAssistantBrief[]> {
    return AssistantBriefModel.find({ userId, ...ACTIVITY_BRIEF })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  },

  /**
   * The end of the previous brief's window, which the next brief starts from. A busy-block brief never
   * advances it, so runs from before the block still reach the next regular brief.
   */
  async findLatestReady(userId: string): Promise<IAssistantBrief | null> {
    return AssistantBriefModel.findOne({ userId, status: 'ready', trigger: { $ne: 'busy_block' }, ...ACTIVITY_BRIEF })
      .sort({ createdAt: -1 })
      .lean();
  },

  /**
   * What the pending-decisions count reads: the latest ready brief's id, and the approval ref and reply stamp
   * of each decision in the latest regular ready brief (follow-up memo briefs excluded) plus the busy-block briefs readied since it. A block
   * brief does not replace the regular one, and the email it carried is not briefed again.
   */
  async findLatestReadyDecisionRefs(userId: string): Promise<{
    _id: mongoose.Types.ObjectId;
    decisions: Array<Pick<StoredBriefDecision, 'approval' | 'repliedAt' | 'followUp'>>;
  } | null> {
    type Refs = {
      _id: mongoose.Types.ObjectId;
      createdAt: Date;
      decisions?: Array<Pick<StoredBriefDecision, 'approval' | 'repliedAt' | 'followUp'>>;
    };
    const fields = '_id createdAt decisions.approval decisions.repliedAt decisions.followUp.state';
    const regular = await AssistantBriefModel.findOne({
      userId,
      status: 'ready',
      trigger: { $ne: 'busy_block' },
      ...ACTIVITY_BRIEF,
    })
      .sort({ createdAt: -1 })
      .select(fields)
      .lean<Refs>();
    const blockBriefs = await AssistantBriefModel.find({
      userId,
      status: 'ready',
      trigger: 'busy_block',
      ...ACTIVITY_BRIEF,
      ...(regular && { createdAt: { $gte: regular.createdAt } }),
    })
      .sort({ createdAt: -1 })
      .limit(BLOCK_BRIEFS_COUNTED_MAX)
      .select(fields)
      .lean<Refs[]>();
    const newest = blockBriefs[0] ?? regular;
    if (!newest) return null;
    const counted = regular ? [...blockBriefs, regular] : blockBriefs;
    return { _id: newest._id, decisions: counted.flatMap(brief => brief.decisions ?? []) };
  },

  /** Only a `composing` brief can be settled, so a redelivered event never overwrites a finished one. */
  /** `periodEnd` narrows the stored window, so activity it would have covered stays in the next brief's. */
  async markReady(
    id: string,
    content: AssistantBriefContent,
    composedAt: Date,
    options: { periodEnd?: Date } = {}
  ): Promise<boolean> {
    const result = await AssistantBriefModel.updateOne(
      { _id: id, status: 'composing' },
      {
        $set: { ...content, status: 'ready', composedAt, ...(options.periodEnd && { periodEnd: options.periodEnd }) },
        $unset: { followUpInput: 1 },
      },
      { runValidators: true }
    );
    return result.modifiedCount === 1;
  },

  async markFailed(id: string, failureReason: string): Promise<boolean> {
    const result = await AssistantBriefModel.updateOne(
      { _id: id, status: 'composing' },
      { $set: { status: 'failed', failureReason }, $unset: { followUpInput: 1 } },
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

  /**
   * Applies an edit to a follow-up decision while it is still pending; `false` when the brief, the decision
   * or a pending follow-up on it is missing (the route tells those apart with `findByIdForUser`).
   */
  async editFollowUpDecision(
    id: string,
    userId: string,
    decisionId: string,
    edit: FollowUpDecisionEdit
  ): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const set: Record<string, unknown> = {};
    if (edit.text !== undefined) set['decisions.$.text'] = edit.text;
    if (edit.remindAt !== undefined) set['decisions.$.followUp.remindAt'] = edit.remindAt;
    for (const [field, value] of Object.entries(edit.draftReply ?? {})) {
      if (value !== undefined) set[`decisions.$.draftReply.${field}`] = value;
    }
    if (Object.keys(set).length === 0) return false;
    const result = await AssistantBriefModel.updateOne(
      { _id: id, userId, decisions: { $elemMatch: { id: decisionId, 'followUp.state': 'pending' } } },
      { $set: set },
      { runValidators: true }
    );
    return result.matchedCount === 1;
  },

  /**
   * Approves or dismisses a pending follow-up decision, once: only the first caller gets `true`. `expected`
   * pins the values the caller validated, so a concurrent edit makes the claim miss instead of approving them.
   */
  async resolveFollowUpDecision(
    id: string,
    userId: string,
    decisionId: string,
    state: 'approved' | 'dismissed',
    at: Date = new Date(),
    expected: { to?: string; remindAt?: Date } = {}
  ): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const match: Record<string, unknown> = { id: decisionId, 'followUp.state': 'pending' };
    if (expected.to !== undefined) match['draftReply.to'] = expected.to;
    if (expected.remindAt !== undefined) match['followUp.remindAt'] = expected.remindAt;
    const result = await AssistantBriefModel.updateOne(
      { _id: id, userId, decisions: { $elemMatch: match } },
      { $set: { 'decisions.$.followUp.state': state, 'decisions.$.followUp.decidedAt': at } },
      { runValidators: true }
    );
    return result.modifiedCount === 1;
  },

  /** Approved reminders due at or before `now` that no brief has listed yet, earliest first. */
  async findDueReminders(userId: string, now: Date, limit: number): Promise<DueReminder[]> {
    const due = {
      'decisions.followUp.kind': 'reminder',
      'decisions.followUp.state': 'approved',
      'decisions.followUp.remindAt': { $lte: now },
      'decisions.followUp.surfacedAt': null,
    };
    const rows = await AssistantBriefModel.aggregate<{ _id: mongoose.Types.ObjectId; decision: StoredBriefDecision }>([
      { $match: { userId, origin: 'followUp', ...due } },
      { $unwind: '$decisions' },
      { $match: due },
      { $sort: { 'decisions.followUp.remindAt': 1 } },
      { $limit: limit },
      { $project: { decision: '$decisions' } },
    ]);
    return rows.map(row => ({
      briefId: String(row._id),
      decisionId: row.decision.id,
      text: row.decision.text,
      remindAt: row.decision.followUp?.remindAt as Date,
    }));
  },

  /** Stamps reminders as listed in a brief so the next brief does not repeat them. */
  async markRemindersSurfaced(
    userId: string,
    refs: Array<Pick<DueReminder, 'briefId' | 'decisionId'>>,
    at: Date
  ): Promise<void> {
    for (const ref of refs) {
      if (!mongoose.isValidObjectId(ref.briefId)) continue;
      await AssistantBriefModel.updateOne(
        { _id: ref.briefId, userId },
        { $set: { 'decisions.$[d].followUp.surfacedAt': at } },
        {
          arrayFilters: [{ 'd.id': ref.decisionId, 'd.followUp.state': 'approved', 'd.followUp.surfacedAt': null }],
          runValidators: true,
        }
      );
    }
  },

  /**
   * The earliest approved reminder not yet listed in a brief (due strictly after `after` when given), so a
   * schedule save or a fired slot keeps a pulled-forward slot.
   */
  async findEarliestPendingReminderAt(userId: string, after?: Date): Promise<Date | null> {
    const [row] = await AssistantBriefModel.aggregate<{ remindAt: Date }>([
      { $match: { userId, origin: 'followUp', 'decisions.followUp.kind': 'reminder' } },
      { $unwind: '$decisions' },
      {
        $match: {
          'decisions.followUp.kind': 'reminder',
          'decisions.followUp.state': 'approved',
          'decisions.followUp.remindAt': after ? { $gt: after } : { $ne: null },
          'decisions.followUp.surfacedAt': null,
        },
      },
      { $sort: { 'decisions.followUp.remindAt': 1 } },
      { $limit: 1 },
      { $project: { _id: 0, remindAt: '$decisions.followUp.remindAt' } },
    ]);
    return row?.remindAt ?? null;
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
