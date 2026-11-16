import mongoose, { Model, Schema, model } from 'mongoose';
import type { ILoopMirror, LoopMirrorSnapshot } from '@bike4mind/common/loops';

const ModelName = 'LoopMirror';

interface ILoopMirrorDoc extends ILoopMirror {
  userId: string;
}

export interface ILoopMirrorModel extends Model<ILoopMirrorDoc> {}

/**
 * Desktop-owned loops as their Desktop last reported them (apps/desktop/src/main/loops/local/mirror.ts): a
 * read-only status snapshot for the web and phone. The Desktop's own store stays the source of truth.
 */
export class LoopMirrorRepository {
  constructor(private mirrorModel: ILoopMirrorModel) {}

  async upsert(userId: string, localLoopId: string, snapshot: LoopMirrorSnapshot, now: Date): Promise<void> {
    await this.mirrorModel.updateOne(
      { userId, localLoopId },
      { $set: { snapshot, lastSeenAt: now } },
      { upsert: true }
    );
  }

  async exists(userId: string, localLoopId: string): Promise<boolean> {
    return (await this.mirrorModel.exists({ userId, localLoopId })) !== null;
  }

  async countForUser(userId: string): Promise<number> {
    return this.mirrorModel.countDocuments({ userId });
  }

  async remove(userId: string, localLoopId: string): Promise<void> {
    await this.mirrorModel.deleteOne({ userId, localLoopId });
  }

  async listForUser(userId: string): Promise<ILoopMirror[]> {
    const rows = await this.mirrorModel.find({ userId }).sort({ lastSeenAt: -1 }).lean();
    return rows.map(({ localLoopId, snapshot, lastSeenAt }) => ({ localLoopId, snapshot, lastSeenAt }));
  }
}

export const LoopMirrorSchema = new Schema<ILoopMirrorDoc, ILoopMirrorModel>(
  {
    userId: { type: String, required: true },
    localLoopId: { type: String, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: true }
);

LoopMirrorSchema.index({ userId: 1, localLoopId: 1 }, { unique: true });

export const LoopMirror: ILoopMirrorModel =
  (mongoose.models[ModelName] as unknown as ILoopMirrorModel) ??
  model<ILoopMirrorDoc, ILoopMirrorModel>(ModelName, LoopMirrorSchema);

export const loopMirrorRepository = new LoopMirrorRepository(LoopMirror);

export default LoopMirror;
