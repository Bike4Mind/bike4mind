import mongoose, { Document, Model, Schema, model } from 'mongoose';
import { randomBytes } from 'crypto';
import type { ISkillListing } from '@bike4mind/common';
import { softDeletePlugin } from '../../utils/mongo';

/**
 * A Skill Market listing. Holds a denormalized copy of its current APPROVED version (name,
 * description, honest summary, ...) so browse, search, cards and the importer staleness check read
 * only this collection; pending content lives only on SkillListingVersion.
 *
 * Every write that publishes a version goes through `approvePendingListingVersion`, a CAS on
 * `pendingVersionId`, so a stale approve (or one racing a newer resubmit) cannot publish a
 * superseded version.
 */
export interface ISkillListingDocument extends Omit<ISkillListing, 'id'>, Document {
  id: string;
  activeSlot?: boolean;
}

/** 24 random bytes -> 192-bit base64url token for unlisted links. */
export const newSkillListingShareToken = (): string => randomBytes(24).toString('base64url');

const SkillListingSchema = new Schema<ISkillListingDocument>(
  {
    sourceSkillId: { type: String, required: true },
    authorUserId: { type: String, required: true },
    authorName: { type: String, maxlength: 200 },
    visibility: { type: String, required: true, enum: ['public', 'organization', 'unlisted'] },
    organizationId: { type: String },
    tags: { type: [String], default: [] },
    status: {
      type: String,
      required: true,
      enum: ['in_review', 'approved', 'rejected', 'delisted', 'withdrawn'],
      default: 'in_review',
    },
    shareToken: { type: String, required: true, unique: true, default: newSkillListingShareToken },
    currentApprovedVersionId: { type: String, default: null },
    currentVersion: { type: Number, default: null },
    pendingVersionId: { type: String, default: null },
    pendingVersion: { type: Number, default: null },
    latestVersion: { type: Number, default: 0 },

    name: { type: String, required: true, maxlength: 64 },
    description: { type: String, required: true, maxlength: 500 },
    honestSummaryText: { type: String, maxlength: 2000 },
    descriptionMatches: { type: Boolean },
    usesTools: { type: Boolean, default: false },
    riskTier: { type: String, enum: ['clean', 'review', 'high'] },
    autoChecked: { type: Boolean, default: false },
    publishedAt: { type: Date, default: null },

    importCount: { type: Number, default: 0 },
    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },

    /** Set when distinct-reporter count crosses SkillMarketReportAutoHideThreshold; cleared by an admin restore. */
    hiddenByReports: { type: Boolean, default: false },
    delistedReason: { type: String, maxlength: 1000 },
    delistedBySuperAdmin: { type: Boolean },
    /**
     * True while the listing holds its author's one slot for `sourceSkillId` (any status but
     * withdrawn/delisted, not deleted). Unset by withdraw, delist and soft delete; set again by a
     * restore. A partial unique index needs it: partialFilterExpression cannot express `$nin`.
     */
    activeSlot: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    collection: 'skill_listings',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

SkillListingSchema.plugin(softDeletePlugin);

SkillListingSchema.pre('validate', function (next) {
  if (this.visibility === 'organization' && !this.organizationId) {
    next(new Error('An organization listing requires organizationId'));
    return;
  }
  next();
});

// Per CLAUDE.md MongoDB guideline: performance indexes declared together at the bottom.
SkillListingSchema.index({ status: 1, visibility: 1, organizationId: 1 });
SkillListingSchema.index({ authorUserId: 1, createdAt: -1 });
SkillListingSchema.index({ sourceSkillId: 1 });
SkillListingSchema.index(
  { authorUserId: 1, sourceSkillId: 1 },
  { unique: true, partialFilterExpression: { activeSlot: true }, name: 'skill_listing_one_active_per_skill' }
);
SkillListingSchema.index(
  { name: 'text', description: 'text', tags: 'text', honestSummaryText: 'text' },
  { name: 'skill_listing_text', weights: { name: 10, tags: 5, description: 3, honestSummaryText: 2 } }
);

export const SkillListing: Model<ISkillListingDocument> =
  (mongoose.models.SkillListing as Model<ISkillListingDocument>) ??
  model<ISkillListingDocument>('SkillListing', SkillListingSchema);

/** Fields copied from an approved version onto its listing. */
export type SkillListingDenorm = Pick<
  ISkillListing,
  'name' | 'description' | 'honestSummaryText' | 'descriptionMatches' | 'usesTools' | 'riskTier' | 'autoChecked'
>;

/** Listing states that can no longer accept new versions or approvals. */
export const CLOSED_LISTING_STATUSES = ['delisted', 'withdrawn'] as const;

/**
 * Make `versionId` the listing's pending version, unless a NEWER version is already pending or
 * live (a slow scan of v2 must not displace v3). Returns the version it displaced, so the caller
 * can mark that one superseded, or `false` when this version lost and is itself superseded.
 */
export async function setPendingListingVersion(
  listingId: string,
  versionId: string,
  version: number
): Promise<{ displacedVersionId: string | null } | false> {
  const before = await SkillListing.findOneAndUpdate(
    {
      _id: listingId,
      deletedAt: null,
      status: { $nin: CLOSED_LISTING_STATUSES },
      $and: [
        { $or: [{ pendingVersion: null }, { pendingVersion: { $lt: version } }] },
        { $or: [{ currentVersion: null }, { currentVersion: { $lt: version } }] },
      ],
    },
    { $set: { pendingVersionId: versionId, pendingVersion: version } },
    { new: false }
  );
  if (!before) return false;
  // A resubmission after a rejection is under review again, not still "Not published".
  if (before.status === 'rejected') {
    await SkillListing.updateOne({ _id: listingId, status: 'rejected' }, { $set: { status: 'in_review' } });
  }
  return { displacedVersionId: before.pendingVersionId ?? null };
}

/**
 * Publish the pending version: a CAS guarded on it still being the listing's `pendingVersionId`
 * and the listing still open. Returns false when the approve lost (superseded, already decided,
 * withdrawn or delisted); the caller must then leave the version untouched and answer 409.
 */
export async function approvePendingListingVersion(
  listingId: string,
  versionId: string,
  version: number,
  denorm: SkillListingDenorm
): Promise<boolean> {
  const res = await SkillListing.updateOne(
    { _id: listingId, pendingVersionId: versionId, deletedAt: null, status: { $nin: CLOSED_LISTING_STATUSES } },
    {
      $set: {
        ...denorm,
        currentApprovedVersionId: versionId,
        currentVersion: version,
        pendingVersionId: null,
        pendingVersion: null,
        status: 'approved',
        publishedAt: new Date(),
      },
    }
  );
  return res.modifiedCount > 0;
}

/** Drop a pending version (reject / failed scan). Same CAS shape as the approve. */
export async function clearPendingListingVersion(listingId: string, versionId: string): Promise<boolean> {
  const res = await SkillListing.updateOne(
    { _id: listingId, pendingVersionId: versionId },
    { $set: { pendingVersionId: null, pendingVersion: null } }
  );
  if (res.modifiedCount === 0) return false;
  // A listing that never had a live version reads as rejected rather than "in review" forever.
  await SkillListing.updateOne(
    { _id: listingId, currentApprovedVersionId: null, status: 'in_review' },
    { $set: { status: 'rejected' } }
  );
  return true;
}

export default SkillListing;
