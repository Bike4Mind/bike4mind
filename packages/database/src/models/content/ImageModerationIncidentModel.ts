import mongoose, { Schema, model, Document, Model } from 'mongoose';
import type { ImageModerationIncident as ImageModerationIncidentData } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

/**
 * ImageModerationIncident - one row per generated image blocked by auto-moderation.
 * Metadata-only audit trail (no image bytes; byte preservation for section 2258A
 * is Quest 3). Retention: kept indefinitely (moderation/legal audit), no TTL.
 */
// `Omit<Document, 'model'>`: the data field `model` (the generation model name,
// e.g. 'flux-pro-1.1') collides with mongoose `Document.model()` (an instance
// method for looking up sibling models). Without the omit, TS raises TS2320
// ("cannot simultaneously extend" - the two `model` members have incompatible
// types) because the string field and the method can't coexist on one interface.
export interface IImageModerationIncidentDocument
  extends Omit<ImageModerationIncidentData, 'createdAt' | 'updatedAt'>, Omit<Document, 'model'> {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

const ImageModerationIncidentSchema = new Schema(
  {
    userId: { type: String, required: true },
    // Not required: agent-tool callers (image_generation/edit_image tools) have no questId,
    // and some tool harnesses have no sessionId either. Queue-handler callers
    // (ImageGeneration/ImageEdit services) still always pass both.
    sessionId: { type: String },
    questId: { type: String },
    fabFileId: { type: String, required: false },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    labels: [
      {
        _id: false,
        name: { type: String, required: true },
        parentName: { type: String, default: '' },
        confidence: { type: Number, required: true },
      },
    ],
  },
  {
    timestamps: true,
    collection: 'image_moderation_incidents',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes (per MongoDB Index Guidelines)
ImageModerationIncidentSchema.index({ userId: 1, createdAt: -1 }); // per-user history
ImageModerationIncidentSchema.index({ createdAt: -1 }); // moderation queue

export const ImageModerationIncident =
  (mongoose.models.ImageModerationIncident as mongoose.Model<IImageModerationIncidentDocument>) ||
  model<IImageModerationIncidentDocument>('ImageModerationIncident', ImageModerationIncidentSchema);

export class ImageModerationIncidentRepository extends BaseRepository<IImageModerationIncidentDocument> {
  constructor(model: Model<IImageModerationIncidentDocument>) {
    super(model);
  }

  /**
   * Record a block incident (audit trail).
   *
   * Bypasses the generic `BaseRepository.create()` - that method's parameter
   * type is `Omit<T, 'id' | 'updatedAt' | 'createdAt'>`, and here `T`
   * (`IImageModerationIncidentDocument`) also extends mongoose's `Document`,
   * so the omit still requires every `Document` instance method. Calling
   * `this.model.create()` directly accepts the plain input data instead.
   *
   * Returns the hydrated document as-is rather than `.toJSON()`/`.toObject()`:
   * casting a flattened (`FlattenMaps<...>`) result back to
   * `IImageModerationIncidentDocument` fails to typecheck (TS2352) because
   * `FlattenMaps` recurses into every `Document` member - including driver
   * internals like `collection.db.client` - producing a shape that no longer
   * structurally matches the real `MongoClient` type.
   */
  async record(input: ImageModerationIncidentData): Promise<IImageModerationIncidentDocument> {
    return this.model.create(input);
  }
}

export const imageModerationIncidentRepository = new ImageModerationIncidentRepository(ImageModerationIncident);
export default ImageModerationIncident;
