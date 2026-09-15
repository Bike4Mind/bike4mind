import mongoose from 'mongoose';
import { softDeletePlugin } from '../../utils/mongo';
import {
  IImageGenerationTemplate,
  IImageGenerationTemplateDocument,
  IImageGenerationTemplateRepository,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

interface IImageGenerationTemplateModel extends mongoose.Model<IImageGenerationTemplateDocument> {}

/**
 * `.lean()` returns the raw Mongo doc (`_id`, no `id` virtual), but every
 * consumer (client picker, apply, types) expects `id: string`. Surface it
 * explicitly. Mirrors the briefcase repository's `withId`.
 */
type LeanDoc = { _id: unknown } & Partial<IImageGenerationTemplateDocument>;
function withId(doc: LeanDoc): IImageGenerationTemplateDocument {
  return { ...doc, id: String(doc._id) } as IImageGenerationTemplateDocument;
}

class ImageGenerationTemplateRepository
  extends BaseRepository<IImageGenerationTemplateDocument>
  implements IImageGenerationTemplateRepository
{
  constructor(private templateModel: IImageGenerationTemplateModel) {
    super(templateModel);
  }

  /**
   * BaseRepository.create returns `toObject()`, which omits the `id` virtual
   * (only `_id`). Normalize so the create response carries `id: string` like
   * every read path (`withId`) - otherwise the POST response and GET responses
   * disagree on the identity field.
   */
  async create(data: Omit<IImageGenerationTemplateDocument, 'id' | 'createdAt' | 'updatedAt'>) {
    const created = await super.create(data);
    // withId spreads the doc (keeping _id/__v) and adds the `id` string, so the
    // runtime shape still satisfies the base return type.
    return withId(created as unknown as LeanDoc) as unknown as typeof created;
  }

  async listOwned(userId: string, limit: number, skip = 0): Promise<IImageGenerationTemplateDocument[]> {
    const results = await this.templateModel
      .find({ userId, deletedAt: null })
      .sort({ usageCount: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<LeanDoc[]>();
    return results.map(withId);
  }

  async countOwned(userId: string): Promise<number> {
    return this.templateModel.countDocuments({ userId, deletedAt: null });
  }

  async listByModel(userId: string, model: string): Promise<IImageGenerationTemplateDocument[]> {
    const results = await this.templateModel.find({ userId, model, deletedAt: null }).lean<LeanDoc[]>();
    return results.map(withId);
  }

  async findOwned(id: string, userId: string): Promise<IImageGenerationTemplateDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const result = await this.templateModel.findOne({ _id: id, userId, deletedAt: null }).lean<LeanDoc>();
    return result ? withId(result) : null;
  }

  async updateOwned(
    id: string,
    userId: string,
    patch: Partial<IImageGenerationTemplate>
  ): Promise<IImageGenerationTemplateDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    // Scope the update to (id, owner) so a forged id can't touch another user's template.
    const result = await this.templateModel
      .findOneAndUpdate({ _id: id, userId, deletedAt: null }, { $set: patch }, { new: true })
      .lean<LeanDoc>();
    return result ? withId(result) : null;
  }

  async softDeleteOwned(id: string, userId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await this.templateModel.updateOne(
      { _id: id, userId, deletedAt: null },
      { $set: { deletedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }

  async incrementUsage(id: string, userId: string): Promise<IImageGenerationTemplateDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const result = await this.templateModel
      .findOneAndUpdate({ _id: id, userId, deletedAt: null }, { $inc: { usageCount: 1 } }, { new: true })
      .lean<LeanDoc>();
    return result ? withId(result) : null;
  }
}

const ImageGenerationTemplateSchema = new mongoose.Schema<IImageGenerationTemplateDocument>(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 100 },
    description: { type: String, maxlength: 500 },
    category: { type: String, maxlength: 50 },
    // The bound model. Apply is exact-model, so settings are valid for this model
    // by construction. Kept as a free String (not the ImageModels enum) so a
    // retired model id doesn't break reads of an already-saved template.
    model: { type: String, required: true },
    // Model-conditional image-mode settings; validated at the Zod layer on write.
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },
    usageCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

ImageGenerationTemplateSchema.plugin(softDeletePlugin);

// Performance indexes, matching the query shapes (declared together per repo guidelines).
ImageGenerationTemplateSchema.index({ userId: 1, deletedAt: 1 }); // ownership + count
ImageGenerationTemplateSchema.index({ userId: 1, deletedAt: 1, usageCount: -1, createdAt: -1 }); // list sort

export const ImageGenerationTemplate: IImageGenerationTemplateModel =
  (mongoose.models.ImageGenerationTemplate as IImageGenerationTemplateModel) ||
  mongoose.model<IImageGenerationTemplateDocument, IImageGenerationTemplateModel>(
    'ImageGenerationTemplate',
    ImageGenerationTemplateSchema
  );

export const imageGenerationTemplateRepository = new ImageGenerationTemplateRepository(ImageGenerationTemplate);
