import mongoose, { Schema } from 'mongoose';
import { ASSISTANT_INSTRUCTION_LIMITS, BadRequestError } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import { lockRetentionCreator } from '../../utils/organizationRetention';

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

  /** Serialize cap admission with other creates and permanent account deletion. Null means the cap is full. */
  async createWithinCap(input: { userId: string; text: string }, cap: number): Promise<IAssistantInstruction | null> {
    return withTransaction(async session => {
      if (!(await lockRetentionCreator(input.userId, session))) throw new BadRequestError('Account unavailable');
      const userId = input.userId.toLowerCase();
      if ((await AssistantInstructionModel.countDocuments({ userId }).session(session)) >= cap) return null;
      const [created] = await AssistantInstructionModel.create([{ ...input, userId }], { session });
      if (!created) throw new Error('Instruction insert returned no document');
      return created.toObject();
    });
  },

  /** False when the id is malformed, missing, or belongs to someone else. */
  async deleteOwned(userId: string, id: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await AssistantInstructionModel.deleteOne({ _id: id, userId });
    return result.deletedCount === 1;
  },
};
