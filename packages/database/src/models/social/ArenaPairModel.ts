import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import type { ArenaPairSource, IMongoDocument } from '@bike4mind/common';

export interface IArenaAnswer {
  modelId: string;
  text: string;
}

export interface IArenaPairDocument extends IMongoDocument {
  prompt: string;
  taskType: string;
  source: ArenaPairSource;
  answers: [IArenaAnswer, IArenaAnswer];
  /** Present only for gold questions; never leaves the server. */
  goldChoice?: 'a' | 'b';
  active: boolean;
  createdBy: string;
}

const AnswerSchema = new Schema<IArenaAnswer>(
  {
    modelId: { type: String, required: true },
    text: { type: String, required: true },
  },
  { _id: false }
);

const ArenaPairSchema = new Schema<IArenaPairDocument>(
  {
    prompt: { type: String, required: true },
    taskType: { type: String, required: true },
    source: { type: String, enum: ['synthetic', 'opt_in'], required: true },
    answers: {
      type: [AnswerSchema],
      required: true,
      validate: { validator: (answers: unknown[]) => answers.length === 2, message: 'A pair has exactly 2 answers' },
    },
    goldChoice: { type: String, enum: ['a', 'b'] },
    active: { type: Boolean, required: true, default: true },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

ArenaPairSchema.index({ active: 1, goldChoice: 1 });

export interface IArenaPairModel extends Model<IArenaPairDocument> {}

export const ArenaPair: IArenaPairModel =
  mongoose.models.ArenaPair ?? model<IArenaPairDocument>('ArenaPair', ArenaPairSchema);

export type ArenaPairPool = 'gold' | 'regular';

const poolFilter = (pool: ArenaPairPool) =>
  pool === 'gold' ? { goldChoice: { $exists: true } } : { goldChoice: { $exists: false } };

export class ArenaPairRepository extends BaseRepository<IArenaPairDocument> {
  async insertMany(pairs: Omit<IArenaPairDocument, 'id' | 'createdAt' | 'updatedAt'>[]): Promise<number> {
    const inserted = await this.model.insertMany(pairs);
    return inserted.length;
  }

  /** A random active pair from the pool whose id is not in `excludeIds`, or null when none is left. */
  async sampleUnseen(pool: ArenaPairPool, excludeIds: string[]): Promise<IArenaPairDocument | null> {
    const [picked] = await this.model.aggregate<IArenaPairDocument & { _id: mongoose.Types.ObjectId }>([
      {
        $match: {
          active: true,
          ...poolFilter(pool),
          // Grows with each user's vote history; goldChoice:{$exists:false} is not selective on the
          // {active, goldChoice} index. Fine at launch scale.
          _id: { $nin: excludeIds.map(id => new mongoose.Types.ObjectId(id)) },
        },
      },
      { $sample: { size: 1 } },
    ]);
    if (!picked) return null;
    return { ...picked, id: String(picked._id) };
  }

  async listPage(skip: number, limit: number): Promise<{ data: IArenaPairDocument[]; total: number }> {
    const [docs, total] = await Promise.all([
      this.model
        .find({}, { prompt: 1, taskType: 1, source: 1, 'answers.modelId': 1, goldChoice: 1, active: 1, createdAt: 1 })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      this.model.countDocuments(),
    ]);
    return { data: docs.map(doc => doc.toObject()), total };
  }

  async setActive(id: string, active: boolean): Promise<boolean> {
    if (!mongoose.isObjectIdOrHexString(id)) return false;
    const result = await this.model.updateOne({ _id: id }, { $set: { active } });
    return result.matchedCount > 0;
  }

  async countsForStats(): Promise<{ total: number; gold: number; active: number; activeGold: number }> {
    const [total, gold, active, activeGold] = await Promise.all([
      this.model.countDocuments(),
      this.model.countDocuments(poolFilter('gold')),
      this.model.countDocuments({ active: true }),
      this.model.countDocuments({ ...poolFilter('gold'), active: true }),
    ]);
    return { total, gold, active, activeGold };
  }

  /** `projection` limits the fetched fields; the answer texts are large and rarely needed in bulk. */
  async findByIds(ids: string[], projection?: Record<string, 1>): Promise<IArenaPairDocument[]> {
    const valid = ids.filter(id => mongoose.isObjectIdOrHexString(id));
    const docs = await this.model.find({ _id: { $in: valid } }, projection);
    return docs.map(doc => doc.toObject());
  }
}

export const arenaPairRepository = new ArenaPairRepository(ArenaPair);
