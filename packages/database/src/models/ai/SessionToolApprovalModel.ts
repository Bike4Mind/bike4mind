import mongoose, { Model, Schema } from 'mongoose';
import { ISessionToolApproval, ISessionToolApprovalDocument, ISessionToolApprovalRepository } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'SessionToolApproval';

export interface ISessionToolApprovalModel extends Model<ISessionToolApprovalDocument> {}

const SessionToolApprovalSchema = new Schema<ISessionToolApproval, ISessionToolApprovalModel>(
  {
    userId: { type: String, required: true },
    sessionId: { type: String, required: true },
    approvedTools: { type: [String], required: true, default: [] },
    deniedTools: { type: [String], required: true, default: [] },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

SessionToolApprovalSchema.index({ userId: 1, sessionId: 1 }, { unique: true });

const SessionToolApprovalModel =
  (mongoose.models[ModelName] as unknown as ISessionToolApprovalModel) ||
  mongoose.model<ISessionToolApproval>(ModelName, SessionToolApprovalSchema);

export class SessionToolApprovalRepository
  extends BaseRepository<ISessionToolApprovalDocument>
  implements ISessionToolApprovalRepository
{
  constructor(private sessionToolApprovalModel: ISessionToolApprovalModel) {
    super(sessionToolApprovalModel);
  }

  async findByUserAndSession(userId: string, sessionId: string): Promise<ISessionToolApprovalDocument | null> {
    const result = await this.sessionToolApprovalModel.findOne({ userId, sessionId });
    return result?.toJSON() ?? null;
  }

  async rememberDecision(
    userId: string,
    sessionId: string,
    toolName: string,
    decision: 'approved' | 'denied'
  ): Promise<ISessionToolApprovalDocument> {
    // $addToSet on one list and $pull on the other in a single update: the two lists are
    // mutually exclusive, and doing it in two round-trips would leave a window where a
    // concurrent read sees the tool on both (where `deniedTools` wins) and gates a tool
    // the user just approved.
    const addField = decision === 'approved' ? 'approvedTools' : 'deniedTools';
    const pullField = decision === 'approved' ? 'deniedTools' : 'approvedTools';
    const result = await this.sessionToolApprovalModel.findOneAndUpdate(
      { userId, sessionId },
      { $addToSet: { [addField]: toolName }, $pull: { [pullField]: toolName } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return result.toJSON();
  }

  async forgetTool(userId: string, sessionId: string, toolName: string): Promise<ISessionToolApprovalDocument | null> {
    const result = await this.sessionToolApprovalModel.findOneAndUpdate(
      { userId, sessionId },
      { $pull: { approvedTools: toolName, deniedTools: toolName } },
      { new: true }
    );
    return result?.toJSON() ?? null;
  }

  async forgetAll(userId: string, sessionId: string): Promise<void> {
    await this.sessionToolApprovalModel.deleteOne({ userId, sessionId });
  }
}

export const sessionToolApprovalRepository = new SessionToolApprovalRepository(SessionToolApprovalModel);

export default SessionToolApprovalModel;
