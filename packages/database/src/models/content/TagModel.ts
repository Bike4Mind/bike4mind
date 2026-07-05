import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { IFileTag, IFileTagRepository, ITag, ITagRepository, TagType } from '@bike4mind/common';

const options = {
  toJSON: {
    virtuals: true,
  },
  toObject: {
    virtuals: true,
  },
  discriminatorKey: 'type',
};

const TagSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true },
    icon: { type: String, required: false },
    description: { type: String, required: false },
    color: { type: String, required: false },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  options
);

// Ensure unique tags per user
TagSchema.index({ userId: 1, name: 1 }, { unique: true });

const TagModel = (mongoose.models['Tag'] as unknown as mongoose.Model<ITag>) || mongoose.model<ITag>('Tag', TagSchema);

class TagRepository extends BaseRepository<ITag> implements ITagRepository {
  constructor(private tagModel: mongoose.Model<ITag>) {
    super(tagModel);
  }

  async findAllByUserId(userId: string) {
    const result = await this.tagModel.find({ userId });
    return result.map(p => p.toJSON());
  }

  async findByIdAndUserId(id: string, userId: string) {
    const result = await this.tagModel.findOne({ _id: id, userId });
    return result?.toJSON() || null;
  }
}

export const tagRepository = new TagRepository(TagModel);

const FileTagSchema = new mongoose.Schema(
  {
    fileCount: { type: Number, required: true },
    lastActivityAt: { type: Date, required: true },
  },
  options
);

const FileTagModel =
  TagModel.discriminators && TagModel.discriminators[TagType.FILE]
    ? (TagModel.discriminators[TagType.FILE] as mongoose.Model<IFileTag>)
    : TagModel.discriminator<IFileTag>(TagType.FILE, FileTagSchema);

class FileTagRepository extends BaseRepository<IFileTag> implements IFileTagRepository {
  constructor(private fileTagModel: mongoose.Model<IFileTag>) {
    super(fileTagModel);
  }

  async create({ type: _, ...data }: Omit<IFileTag, 'id' | 'createdAt' | 'updatedAt'>) {
    return this.fileTagModel.create(data);
  }

  async update({ type: _, ...data }: Partial<IFileTag>, options?: Record<string, unknown>) {
    const query = this.fileTagModel.findOneAndUpdate({ _id: data.id }, { $set: data }, options);
    // only attach an explicit session when one is set; .session(null) overrides
    // transactionAsyncLocalStorage propagation and silently breaks atomicity.
    if (this._txn) {
      query.session(this._txn);
    }
    const result = await query;

    return result?.toJSON() || null;
  }

  async updateMany(
    filter: Record<string, unknown>,
    { type: _, ...data }: Partial<IFileTag>,
    options?: Record<string, unknown>
  ) {
    return this.fileTagModel.updateMany(filter, { $set: data }, options);
  }

  async findAllByUserId(userId: string) {
    const result = await this.fileTagModel.find({ userId });
    return result.map(p => p.toJSON());
  }

  async findByIdAndUserId(id: string, userId: string) {
    const result = await this.fileTagModel.findOne({ _id: id, userId });
    return result?.toJSON() || null;
  }

  async findAllByIds(ids: string[]) {
    const result = await this.fileTagModel.find({ _id: { $in: ids } });
    return result.map(p => p.toJSON());
  }

  async incrementFileCountBy(by: Pick<IFileTag, 'name' | 'userId'>, count: number = 1): Promise<void> {
    try {
      // Use updateOne instead of findOne + save to avoid potential conflicts
      const filter: Record<string, unknown> = {};
      if (by.name) filter.name = new RegExp(`^${by.name}$`, 'i');
      if (by.userId) filter.userId = by.userId;

      const updateResult = await this.fileTagModel.updateOne(filter, {
        $inc: { fileCount: count },
        $set: { lastActivityAt: new Date() },
      });

      if (updateResult.matchedCount === 0) {
        console.warn(`No tag found matching filter:`, filter);
      }
    } catch (error) {
      console.error('Error incrementing file count:', error);
      throw error;
    }
  }

  async findByNameAndUserId(name: string, userId: string) {
    const result = await this.fileTagModel.findOne({ name, userId });
    return result?.toJSON() || null;
  }

  async incrementFileCountByIds(ids: string[], count: number = 1): Promise<void> {
    try {
      // Use updateMany for bulk updates to avoid potential conflicts
      const updateResult = await this.fileTagModel.updateMany(
        { _id: { $in: ids } },
        {
          $inc: { fileCount: count },
          $set: { lastActivityAt: new Date() },
        }
      );

      if (updateResult.matchedCount === 0) {
        console.warn(`No tags found matching IDs:`, ids);
      }
    } catch (error) {
      console.error('Error incrementing file count by IDs:', error);
      throw error;
    }
  }

  async findOrCreateByNameAndUserId(
    name: string,
    userId: string,
    defaultData: Partial<IFileTag>,
    incrementFileCount: number = 0
  ) {
    try {
      const result = await this.fileTagModel.findOneAndUpdate(
        { name, userId },
        {
          $inc: { fileCount: incrementFileCount || 0 },
          $set: { lastActivityAt: new Date() },
          $setOnInsert: {
            ...defaultData,
            name,
            userId,
            type: TagType.FILE,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      );
      return result?.toJSON() || null;
    } catch (error: any) {
      // Handle duplicate key errors by retrying once
      if (error.code === 11000) {
        // Duplicate key error, tag was created by another request
        // Try to increment the existing tag
        const result = await this.fileTagModel.findOneAndUpdate(
          { name, userId },
          {
            $inc: { fileCount: incrementFileCount || 0 },
            $set: { lastActivityAt: new Date() },
          },
          { new: true }
        );
        return result?.toJSON() || null;
      }
      throw error;
    }
  }
}

export const fileTagRepository = new FileTagRepository(FileTagModel);
