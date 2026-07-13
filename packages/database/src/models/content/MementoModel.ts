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

export const Memento =
  (mongoose.models.Memento as IMementoModel) ?? model<IMementoDocument, IMementoModel>('Memento', MementoSchema);
export default Memento;

class MementoRepository extends BaseRepository<IMementoDocument> implements IMementoRepository {
  async findByUserId(userId: string, options: { tier?: MementoTier; select?: string }): Promise<IMementoDocument[]> {
    const { tier, select } = options;
    const filter: FilterQuery<IMementoDocument> = { userId };
    if (tier) {
      filter.tier = tier;
    }

    const query = this.model.find(filter);
    if (select) {
      query.select(select);
    }
    return query.exec();
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
