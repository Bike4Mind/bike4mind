import mongoose, { Schema, Model, model, FilterQuery } from 'mongoose';
import { IMementoDocument, IMementoRepository, MementoTier, MementoType } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

interface IMementoModel extends Model<IMementoDocument> {
  findByUserId(userId: string): Promise<IMementoDocument[]>;
  findHotMementosByUserId(userId: string): Promise<IMementoDocument[]>;
}

const MementoSchema = new Schema<IMementoDocument, IMementoModel>(
  {
    userId: { type: String, ref: 'User', required: true },
    sessionId: { type: String, ref: 'Session', required: false, default: null },
    questId: { type: String, ref: 'Quest' },
    type: {
      type: String,
      enum: Object.values(MementoType),
      required: true,
    },
    tier: {
      type: String,
      enum: Object.values(MementoTier),
      required: true,
      default: MementoTier.HOT,
    },
    weight: {
      type: Number,
      required: true,
      min: 0,
      max: 1000,
      default: 500,
    },
    summary: { type: String, required: true },
    fullContent: { type: String, required: true },
    tags: [{ type: String }],
    embedding: { type: [Number] },
    // Which model produced `embedding`. Without it a vector is uninterpretable: cosine across two
    // models' spaces is noise, so a read path cannot tell a usable vector from a booby-trapped one.
    // Un-stamped (pre-migration) mementos are treated as untrusted until the re-embed backfill runs.
    embeddingModel: { type: String },
    lastAccessedAt: { type: Date, required: true, default: Date.now },
  },
  {
    timestamps: true,
    statics: {
      findByUserId: async function (userId: string) {
        return this.find({ userId });
      },
      findHotMementosByUserId: async function (userId: string) {
        return this.find({ userId, tier: MementoTier.HOT }).sort({ weight: -1, lastAccessedAt: -1 }); // Highest priority first
      },
    },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

MementoSchema.index({ userId: 1, tier: 1, weight: -1 });
MementoSchema.index({ userId: 1, sessionId: 1 });
MementoSchema.index({ userId: 1, tags: 1 });
// Equality on `userId` plus a range/sort on `_id` is what makes the keyset walk in
// `getRelevantMementos` non-blocking. None of the indexes above can serve a sort on `_id`, so the
// planner would fall back to sorting the user's whole memento set on every page - turning a paged
// read into something more expensive than the unbounded read it replaced. `tier` stays a residual
// filter rather than earning a place in the key: it is absent from the query when tier is 'all'.
MementoSchema.index({ userId: 1, _id: 1 });

export const Memento =
  (mongoose.models.Memento as IMementoModel) ?? model<IMementoDocument, IMementoModel>('Memento', MementoSchema);
export default Memento;

class MementoRepository extends BaseRepository<IMementoDocument> implements IMementoRepository {
  /**
   * `limit`/`afterId` turn this into a keyset-paged read so a caller can walk a user's mementos
   * without holding all of them at once. Both are opt-in, and `.sort({ _id: 1 })` is applied ONLY
   * when one is supplied: the cursor is meaningless without the sort, and adding the sort
   * unconditionally would change the plan for every existing unpaged caller.
   */
  async findByUserId(
    userId: string,
    options: { tier?: MementoTier; select?: string; limit?: number; afterId?: string }
  ): Promise<IMementoDocument[]> {
    const { tier, select, limit, afterId } = options;
    const filter: FilterQuery<IMementoDocument> = { userId };
    if (tier) {
      filter.tier = tier;
    }
    if (afterId) {
      filter._id = { $gt: afterId };
    }

    const query = this.model.find(filter);
    if (select) {
      query.select(select);
    }
    if (limit !== undefined || afterId) {
      query.sort({ _id: 1 });
    }
    if (limit !== undefined) {
      query.limit(limit);
    }
    return query.exec();
  }

  /**
   * Hard-delete specific mementos, owner-scoped. Used by the per-belief V2 shred to remove the V1
   * memento(s) backing a belief - a belief in the unified view can be a V1 memento (deleted by its own
   * id) or a ledger belief with a V1 memento TWIN carrying the same plaintext fact (deleted by fact
   * match). Leaving either behind re-injects the "deleted" fact into the next chat prompt. Owner-scoped
   * so a caller can only delete their own.
   */
  async deleteByIdsForUser(ids: string[], userId: string): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.model.deleteMany({ _id: { $in: ids }, userId });
    return res.deletedCount ?? 0;
  }

  /**
   * Hard-delete every memento for a user - the V1 half of "delete my data".
   *
   * A ledger fact is crypto-shredded (destroy the key, the ciphertext becomes unreadable), but a
   * memento stores its summary, the full original prompt and a plaintext embedding with no key to
   * destroy. Archiving would only hide it: the content would remain in the collection AND keep
   * coming back through the V2 unified read, which unions the ledger with these mementos. Deletion
   * has to be real.
   */
  async deleteAllByUserId(userId: string): Promise<number> {
    const res = await this.model.deleteMany({ userId });
    return res.deletedCount ?? 0;
  }
}

export const mementoRepository = new MementoRepository(Memento);
