import mongoose, { Model, Schema, model } from 'mongoose';
import { ILoopRunnerPresence, ILoopRunnerPresenceRepository } from '@bike4mind/common';

const ModelName = 'LoopRunnerPresence';

export interface ILoopRunnerPresenceModel extends Model<ILoopRunnerPresence> {}

/** A user's desktop loop runner as it last reported itself; the loop board reads it for its waiting text. */
export class LoopRunnerPresenceRepository implements ILoopRunnerPresenceRepository {
  constructor(private presenceModel: ILoopRunnerPresenceModel) {}

  async upsertForUser(userId: string, fields: Omit<ILoopRunnerPresence, 'id' | 'userId'>): Promise<void> {
    const { waitingReason, ...rest } = fields;
    await this.presenceModel.updateOne(
      { userId },
      {
        $set: { ...rest, ...(waitingReason && { waitingReason }) },
        ...(!waitingReason && { $unset: { waitingReason: '' } }),
      },
      { upsert: true }
    );
  }

  async findByUserId(userId: string): Promise<ILoopRunnerPresence | null> {
    return (await this.presenceModel.findOne({ userId }))?.toJSON() ?? null;
  }
}

export const LoopRunnerPresenceSchema = new Schema<ILoopRunnerPresence, ILoopRunnerPresenceModel>(
  {
    userId: { type: String, required: true, unique: true },
    seenAt: { type: Date, required: true },
    lanesBusy: { type: Number, required: true },
    lanesFree: { type: Number, required: true },
    waitingReason: { type: String },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

export const LoopRunnerPresence: ILoopRunnerPresenceModel =
  (mongoose.models[ModelName] as unknown as ILoopRunnerPresenceModel) ??
  model<ILoopRunnerPresence, ILoopRunnerPresenceModel>(ModelName, LoopRunnerPresenceSchema);

export const loopRunnerPresenceRepository = new LoopRunnerPresenceRepository(LoopRunnerPresence);

export default LoopRunnerPresence;
