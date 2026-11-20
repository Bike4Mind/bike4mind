import mongoose, { Document, Model, Schema, model } from 'mongoose';
import type { ISkillBundle } from '@bike4mind/common';

/**
 * An org admin's curated set of the org's Organization listings, served as one Claude Code plugin
 * in the org's feed (apps/client/server/skillMarket/claudeMarketplace.ts). It holds membership only:
 * each member is scanned and reviewed as its own listing, so a bundle needs no scan of its own.
 *
 * `pluginName` shares the org feed's namespace with listings' `claudePluginName`: the bundle routes
 * refuse a name a listing holds, and `assignClaudePluginName` skips names a bundle holds.
 */
export interface ISkillBundleDocument extends Omit<ISkillBundle, 'id'>, Document {
  id: string;
}

export const SKILL_BUNDLE_MAX_LISTINGS = 50;

const SkillBundleSchema = new Schema<ISkillBundleDocument>(
  {
    organizationId: { type: String },
    spaceId: { type: String },
    name: { type: String, required: true, maxlength: 64 },
    description: { type: String, required: true, maxlength: 500 },
    pluginName: { type: String, required: true, maxlength: 64 },
    listingIds: {
      type: [String],
      default: [],
      validate: (ids: string[]) => ids.length <= SKILL_BUNDLE_MAX_LISTINGS,
    },
    createdByUserId: { type: String, required: true },
  },
  {
    timestamps: true,
    collection: 'skill_bundles',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

SkillBundleSchema.pre('validate', function () {
  if ((this.organizationId == null) === (this.spaceId == null)) {
    this.invalidate('organizationId', 'A bundle needs exactly one of organizationId or spaceId');
  }
});

// Keeps the legacy auto-generated name so pre-deploy instances hit a name conflict instead of rebuilding the old key.
SkillBundleSchema.index(
  { organizationId: 1, spaceId: 1, pluginName: 1 },
  { unique: true, name: 'organizationId_1_pluginName_1' }
);

export const SkillBundle: Model<ISkillBundleDocument> =
  (mongoose.models.SkillBundle as Model<ISkillBundleDocument>) ??
  model<ISkillBundleDocument>('SkillBundle', SkillBundleSchema);

export default SkillBundle;
