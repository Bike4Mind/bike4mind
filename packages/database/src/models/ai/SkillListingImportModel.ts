import mongoose, { Document, Model, Schema, model } from 'mongoose';
import type { ISkillListingImport } from '@bike4mind/common';

/**
 * One row per (listing, importer). It is also where the importer's rating lives, so the unique
 * index gives one-rating-per-user and the row's existence is the "importer only" rating gate. The
 * same rows drive importCount, trending and "popular in your org".
 */
export interface ISkillListingImportDocument extends Omit<ISkillListingImport, 'id'>, Document {
  id: string;
}

const SkillListingImportSchema = new Schema<ISkillListingImportDocument>(
  {
    listingId: { type: String, required: true },
    userId: { type: String, required: true },
    skillId: { type: String, required: true },
    version: { type: Number, required: true },
    importedAt: { type: Date, required: true, default: () => new Date() },
    stars: { type: Number, min: 1, max: 5 },
    review: { type: String, maxlength: 1000 },
    ratedAt: { type: Date },
  },
  {
    timestamps: true,
    collection: 'skill_listing_imports',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

SkillListingImportSchema.index({ listingId: 1, userId: 1 }, { unique: true });
SkillListingImportSchema.index({ userId: 1 });
SkillListingImportSchema.index({ listingId: 1, importedAt: -1 });
SkillListingImportSchema.index({ importedAt: -1 });

export const SkillListingImport: Model<ISkillListingImportDocument> =
  (mongoose.models.SkillListingImport as Model<ISkillListingImportDocument>) ??
  model<ISkillListingImportDocument>('SkillListingImport', SkillListingImportSchema);

export default SkillListingImport;
