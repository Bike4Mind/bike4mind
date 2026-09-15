import mongoose, { Model, Schema } from 'mongoose';
import { IEmbeddingCacheDocument, IEmbeddingCacheRepository } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

interface IEmbeddingCacheModel extends Model<IEmbeddingCacheDocument> {}

export class EmbeddingCacheRepository
  extends BaseRepository<IEmbeddingCacheDocument>
  implements IEmbeddingCacheRepository
{
  constructor(private embeddingCacheModel: IEmbeddingCacheModel) {
    super(embeddingCacheModel);
  }

  async findByHash(contentHash: string, model: string): Promise<IEmbeddingCacheDocument | null> {
    const result = await this.embeddingCacheModel.findOne({ contentHash, model }).lean();
    return result as IEmbeddingCacheDocument | null;
  }

  async upsert(
    data: Omit<IEmbeddingCacheDocument, 'id' | 'accessCount' | 'lastAccessedAt'>
  ): Promise<IEmbeddingCacheDocument> {
    const result = await this.embeddingCacheModel.findOneAndUpdate(
      { contentHash: data.contentHash, model: data.model },
      {
        $setOnInsert: {
          contentHash: data.contentHash,
          vector: data.vector,
          model: data.model,
          tokenCount: data.tokenCount,
          createdAt: data.createdAt,
          accessCount: 0,
          lastAccessedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    return result.toJSON() as IEmbeddingCacheDocument;
  }

  async incrementAccessCount(contentHash: string, model: string): Promise<void> {
    await this.embeddingCacheModel.updateOne(
      { contentHash, model },
      {
        $inc: { accessCount: 1 },
        $set: { lastAccessedAt: new Date() },
      }
    );
  }
}

const embeddingCacheSchema = new Schema<IEmbeddingCacheDocument, IEmbeddingCacheModel>(
  {
    contentHash: {
      type: String,
      required: true,
    },
    vector: {
      type: [Number],
      required: true,
    },
    model: {
      type: String,
      required: true,
    },
    tokenCount: {
      type: Number,
      required: true,
      default: 0,
    },
    createdAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    accessCount: {
      type: Number,
      required: true,
      default: 0,
    },
    lastAccessedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
  },
  {
    collection: 'embedding_cache',
    timestamps: false, // createdAt is managed manually
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
      },
    },
  }
);

embeddingCacheSchema.index({ contentHash: 1, model: 1 }, { unique: true });

// TTL index: expire after 90 days
embeddingCacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

embeddingCacheSchema.index({ lastAccessedAt: 1 });

export const EmbeddingCache =
  (mongoose.models.EmbeddingCache as IEmbeddingCacheModel) ??
  mongoose.model<IEmbeddingCacheDocument, IEmbeddingCacheModel>('EmbeddingCache', embeddingCacheSchema);

export const embeddingCacheRepository = new EmbeddingCacheRepository(EmbeddingCache);
