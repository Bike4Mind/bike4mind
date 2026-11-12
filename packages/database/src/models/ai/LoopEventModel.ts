import mongoose, { Model, Schema, model } from 'mongoose';
import {
  ILoopEvent,
  ILoopEventRepository,
  LOOP_EVENT_KINDS,
  LoopAskedFields,
  LoopAutoResumedFields,
  LoopConfigChangedFields,
  LoopEventKind,
  LoopGateOutcome,
  LoopHandoffFields,
  LoopUnsureFields,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'LoopEvent';

export interface ILoopEventModel extends Model<ILoopEvent> {}

export class LoopEventRepository extends BaseRepository<ILoopEvent> implements ILoopEventRepository {
  constructor(private loopEventModel: ILoopEventModel) {
    super(loopEventModel);
    this.loopEventModel = loopEventModel;
  }

  async recordUnsure(fields: LoopUnsureFields | LoopAskedFields): Promise<void> {
    await this.loopEventModel.updateOne(
      { executionId: fields.executionId, requestedAt: fields.requestedAt },
      { $setOnInsert: { ...fields, kind: 'unsure' } },
      { upsert: true }
    );
  }

  async recordAutoResumed(fields: LoopAutoResumedFields): Promise<void> {
    await this.loopEventModel.create({ ...fields, kind: 'auto_resumed' });
  }

  async recordHandoff(fields: LoopHandoffFields): Promise<void> {
    const { userId, fromLoop, toLoop, workItemId, ticketTitle, stage, by, via, executionId, note, at } = fields;
    const row = (direction: 'out' | 'in') => {
      const [loop, other] = direction === 'out' ? [fromLoop, toLoop] : [toLoop, fromLoop];
      return {
        loopId: loop.id,
        userId,
        kind: 'handoff',
        // Synthetic, so the unique (executionId, requestedAt) index holds both rows and no real run ever matches.
        executionId: `handoff:${workItemId}:${direction}:${at.getTime()}`,
        requestedAt: at,
        workItemId,
        ticketTitle,
        reason: direction === 'out' ? `Handed to ${other.name}` : `Received from ${other.name}`,
        handoff: {
          direction,
          otherLoopId: other.id,
          otherLoopName: other.name,
          stage,
          by,
          ...(via && { via }),
          ...(executionId && { executionId }),
          ...(note && { note }),
        },
      };
    };
    await this.loopEventModel.insertMany([row('out'), row('in')]);
  }

  async recordConfigChanged({ loopId, userId, reason, at }: LoopConfigChangedFields): Promise<void> {
    await this.loopEventModel.create({
      loopId,
      userId,
      kind: 'config_changed',
      // Synthetic, like recordHandoff's, so the unique (executionId, requestedAt) index holds it.
      executionId: `config:${loopId}:${at.getTime()}`,
      requestedAt: at,
      reason,
    });
  }

  async listForLoopSince(
    userId: string,
    loopId: string,
    since: Date,
    kinds: LoopEventKind[] | undefined,
    limit: number
  ): Promise<ILoopEvent[]> {
    const results = await this.loopEventModel
      .find({ userId, loopId, createdAt: { $gte: since }, ...(kinds && { kind: { $in: kinds } }) })
      .sort({ createdAt: 1 })
      .limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async listUnresolvedUnsure(userId: string, loopId: string, limit: number): Promise<ILoopEvent[]> {
    const results = await this.loopEventModel
      .find({ userId, loopId, kind: 'unsure', resolution: { $exists: false } })
      .sort({ createdAt: 1 })
      .limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async resolveUnsure(
    fields: LoopUnsureFields,
    resolution: { outcome: LoopGateOutcome; by?: string; at: Date }
  ): Promise<void> {
    await this.recordUnsure(fields);
    // Not an upsert: with `resolution` in the filter, an already-resolved event would insert a duplicate.
    await this.loopEventModel.updateOne(
      { executionId: fields.executionId, requestedAt: fields.requestedAt, resolution: { $exists: false } },
      { $set: { resolution } }
    );
  }

  async listForLoop(userId: string, loopId: string, limit: number): Promise<ILoopEvent[]> {
    const results = await this.loopEventModel.find({ userId, loopId }).sort({ createdAt: -1 }).limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async listResumedUnfolded(limit: number): Promise<ILoopEvent[]> {
    const results = await this.loopEventModel
      .find({ 'resolution.outcome': 'resumed', foldedAt: { $exists: false } })
      .sort({ createdAt: 1 })
      .limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async hasUnfolded(executionId: string): Promise<boolean> {
    return !!(await this.loopEventModel.exists({
      executionId,
      'resolution.outcome': 'resumed',
      foldedAt: { $exists: false },
    }));
  }

  async markFolded(id: string, now: Date): Promise<void> {
    await this.loopEventModel.updateOne({ _id: id, foldedAt: { $exists: false } }, { $set: { foldedAt: now } });
  }

  async resolveAsked(
    id: string,
    userId: string,
    loopId: string,
    resolution: NonNullable<ILoopEvent['resolution']>
  ): Promise<ILoopEvent | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await this.loopEventModel.findOneAndUpdate(
      { _id: id, userId, loopId, kind: 'unsure', source: 'asked', resolution: { $exists: false } },
      { $set: { resolution, foldedAt: resolution.at } },
      { new: true }
    );
    return doc ? doc.toJSON() : null;
  }

  async reopenAsked(id: string, at: Date): Promise<void> {
    if (!mongoose.isValidObjectId(id)) return;
    await this.loopEventModel.updateOne(
      { _id: id, source: 'asked', 'resolution.at': at },
      { $unset: { resolution: 1, foldedAt: 1 } }
    );
  }

  async closeAskedForHandoff(userId: string, loopId: string, workItemId: string, at: Date): Promise<number> {
    // foldedAt too, like resolveAsked, so the resumed-run fold never looks at it.
    const result = await this.loopEventModel.updateMany(
      { userId, loopId, workItemId, kind: 'unsure', source: 'asked', resolution: { $exists: false } },
      { $set: { resolution: { outcome: 'handed_off', at }, foldedAt: at } }
    );
    return result.modifiedCount;
  }

  async listAnsweredForTicket(userId: string, workItemId: string, limit: number): Promise<ILoopEvent[]> {
    const results = await this.loopEventModel
      .find({
        userId,
        workItemId,
        source: 'asked',
        'resolution.outcome': 'resumed',
        'resolution.note': { $exists: true },
      })
      .sort({ createdAt: -1 })
      .limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async deleteManyForLoop(userId: string, loopId: string): Promise<number> {
    const result = await this.loopEventModel.deleteMany({ userId, loopId });
    return result.deletedCount;
  }
}

function isGateUnsure(this: ILoopEvent): boolean {
  return this.kind === 'unsure' && this.source !== 'asked';
}

export const LoopEventSchema = new Schema<ILoopEvent, ILoopEventModel>(
  {
    loopId: { type: String, required: true },
    userId: { type: String, required: true },
    kind: { type: String, enum: LOOP_EVENT_KINDS, required: true },
    source: { type: String, enum: ['gate', 'asked'] },
    executionId: { type: String, required: true },
    workItemId: { type: String },
    ticketTitle: { type: String },
    iteration: { type: Number, required: isGateUnsure },
    confidence: { type: Number, required: isGateUnsure },
    reason: { type: String, required: true },
    requestedAt: { type: Date, required: true },
    resolution: {
      type: new Schema(
        {
          outcome: { type: String, enum: ['resumed', 'rejected', 'handed_off'], required: true },
          by: { type: String },
          at: { type: Date, required: true },
          note: { type: String },
        },
        { _id: false }
      ),
    },
    foldedAt: { type: Date },
    handoff: {
      type: new Schema(
        {
          direction: { type: String, enum: ['out', 'in'], required: true },
          otherLoopId: { type: String, required: true },
          otherLoopName: { type: String, required: true },
          stage: { type: String, required: true },
          by: { type: String, enum: ['run', 'owner'], required: true },
          via: { type: String, enum: ['trigger'] },
          executionId: { type: String },
          note: { type: String },
        },
        { _id: false }
      ),
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// No TTL: the log outlives the 90-day execution TTL and is deleted with its loop.
LoopEventSchema.index({ loopId: 1, createdAt: -1 });
LoopEventSchema.index({ executionId: 1, requestedAt: 1 }, { unique: true });
LoopEventSchema.index(
  { 'resolution.outcome': 1, foldedAt: 1 },
  { partialFilterExpression: { 'resolution.outcome': 'resumed' } }
);
LoopEventSchema.index({ workItemId: 1, createdAt: -1 }, { partialFilterExpression: { source: 'asked' } });

export const LoopEvent: ILoopEventModel =
  (mongoose.models[ModelName] as unknown as ILoopEventModel) ??
  model<ILoopEvent, ILoopEventModel>(ModelName, LoopEventSchema);

export const loopEventRepository = new LoopEventRepository(LoopEvent);

export default LoopEvent;
