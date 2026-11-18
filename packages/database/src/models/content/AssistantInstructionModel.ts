import mongoose, { Schema } from 'mongoose';
import { ASSISTANT_INSTRUCTION_LIMITS } from '@bike4mind/common';

/**
 * A standing instruction a user keeps for their assistant, read by the brief composer
 * (apps/workers/src/events/briefCompose.ts). The wire shape is `AssistantInstructionSchema` in @bike4mind/common.
 */
export type IAssistantInstruction = {
  _id: mongoose.Types.ObjectId;
  userId: string;
  text: string;
  createdAt: Date;
  updatedAt: Date;
};

const schema = new Schema<IAssistantInstruction>(
  {
    userId: { type: String, required: true },
    text: { type: String, required: true, maxlength: ASSISTANT_INSTRUCTION_LIMITS.text },
  },
  { timestamps: true, versionKey: false, collection: 'AssistantInstruction' }
);

schema.index({ userId: 1, createdAt: 1 });

export const AssistantInstructionModel =
  (mongoose.models.AssistantInstruction as mongoose.Model<IAssistantInstruction> | undefined) ??
  mongoose.model<IAssistantInstruction>('AssistantInstruction', schema);

// Bounds how long a save ranked within the cap waits for racing saves ranked past it to back off.
const CAP_SETTLE_ATTEMPTS = 10;
const CAP_SETTLE_DELAY_MS = 25;

/** Every method is scoped to the owner, so another user's instruction reads as missing. */
export const assistantInstructionRepository = {
  /** Unlimited on purpose: `createWithinCap` bounds the set, and every counted row must stay visible and deletable. */
  async listByUser(userId: string): Promise<IAssistantInstruction[]> {
    return AssistantInstructionModel.find({ userId }).sort({ createdAt: 1, _id: 1 }).lean();
  },

  async create(input: { userId: string; text: string }): Promise<IAssistantInstruction> {
    const created = await AssistantInstructionModel.create(input);
    return created.toObject();
  },

  /**
   * Saves unless the user already holds `cap` instructions; null when refused. A save keeps its row only after
   * a post-insert recount sees at most `cap`, so racing saves never leave more. When a race overshoots, the rows
   * ranked past `cap` back off at once and the rest wait for that, so a race for the last slot still has a winner.
   */
  async createWithinCap(input: { userId: string; text: string }, cap: number): Promise<IAssistantInstruction | null> {
    const owned = { userId: input.userId };
    if ((await AssistantInstructionModel.countDocuments(owned)) >= cap) return null;
    const created = await AssistantInstructionModel.create(input);
    for (let attempt = 0; ; attempt++) {
      if ((await AssistantInstructionModel.countDocuments(owned)) <= cap) return created.toObject();
      const keepers = await AssistantInstructionModel.find(owned)
        .sort({ createdAt: 1, _id: 1 })
        .limit(cap)
        .select('_id')
        .lean();
      const ranked = keepers.some(row => row._id.equals(created._id));
      if (!ranked || attempt >= CAP_SETTLE_ATTEMPTS) {
        await AssistantInstructionModel.deleteOne({ _id: created._id });
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, CAP_SETTLE_DELAY_MS));
    }
  },

  /** False when the id is malformed, missing, or belongs to someone else. */
  async deleteOwned(userId: string, id: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await AssistantInstructionModel.deleteOne({ _id: id, userId });
    return result.deletedCount === 1;
  },
};
