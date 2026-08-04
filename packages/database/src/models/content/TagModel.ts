import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { IFileTag, IFileTagRepository, ITag, ITagRepository, TagType } from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';

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

  /**
   * Marks a tag as just used. `lastActivityAt` is what the sidebar's recent/default ordering sorts
   * on, and nothing else refreshes it after the document is created, so every path that changes
   * which files carry a tag has to come through here.
   */
  async touchLastActivityBy(by: Pick<IFileTag, 'name' | 'userId'>): Promise<void> {
    try {
      // Use updateOne instead of findOne + save to avoid potential conflicts
      const filter: Record<string, unknown> = {};
      // Escaped for the same reason as findByFoldedNameAndUserId below: a tag name is user text,
      // so an unescaped `a.b` also matched `axb`.
      if (by.name) filter.name = new RegExp(`^${escapeRegex(by.name)}$`, 'i');
      if (by.userId) filter.userId = by.userId;

      const updateResult = await this.fileTagModel.updateOne(filter, {
        $set: { lastActivityAt: new Date() },
      });

      if (updateResult.matchedCount === 0) {
        console.warn(`No tag found matching filter:`, filter);
      }
    } catch (error) {
      console.error('Error touching tag activity:', error);
      throw error;
    }
  }

  async findByNameAndUserId(name: string, userId: string) {
    const result = await this.fileTagModel.findOne({ name, userId });
    return result?.toJSON() || null;
  }

  /**
   * findByNameAndUserId under the shared collision rule (see common/utils/tagName): trimmed and case
   * folded. Every path that mints a tag document checks this first, so one user cannot end up with
   * two names differing only by case.
   *
   * Legacy data can still hold such a pair, so ordered oldest-first rather than left to whatever the
   * scan returns: findOrCreateByNameAndUserId resolves its upsert onto the document this picks, and
   * an unordered read could settle on a different one of the pair on each call.
   *
   * The regex means only the userId prefix of { userId, name } is usable as a bound, so this scans
   * one user's tags. Same cost as touchLastActivityBy above, and small at realistic tag counts.
   */
  async findByFoldedNameAndUserId(name: string, userId: string) {
    const result = await this.fileTagModel
      .findOne({
        name: new RegExp(`^${escapeRegex(name.trim())}$`, 'i'),
        userId,
      })
      .sort({ createdAt: 1, _id: 1 });
    return result?.toJSON() || null;
  }

  /**
   * Upsert a tag by name, resolving to the casing the user already holds. The upsert filter matches
   * the name exactly, so handing it a name the user holds in some other casing minted a second
   * document folding to the same name - the pair the count aggregate reads as two buckets while the
   * file-list filter and the row chips read as one. Folding here rather than at the caller keeps
   * every caller safe by default; see findByFoldedNameAndUserId for the rule.
   */
  async findOrCreateByNameAndUserId(name: string, userId: string, defaultData: Partial<IFileTag>) {
    const held = await this.findByFoldedNameAndUserId(name, userId);
    const upsertName = held?.name ?? name.trim();
    try {
      const result = await this.fileTagModel.findOneAndUpdate(
        { name: upsertName, userId },
        {
          $set: { lastActivityAt: new Date() },
          $setOnInsert: {
            ...defaultData,
            // Same value as the filter: two different ones would conflict on the insert path.
            name: upsertName,
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
        // Duplicate key error, tag was created by another request. Still touch it: this is the
        // losing writer's only chance to record that the tag was just used.
        const result = await this.fileTagModel.findOneAndUpdate(
          { name: upsertName, userId },
          {
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
