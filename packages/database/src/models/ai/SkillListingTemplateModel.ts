import mongoose, { Document, FilterQuery, Model, Schema, model } from 'mongoose';
import {
  SKILL_TEMPLATE_EXAMPLE_PROMPT_MAX,
  SKILL_TEMPLATE_HEADLINE_MAX,
  SKILL_TEMPLATE_INPUT_LABEL_MAX,
  SKILL_TEMPLATE_MAX_INPUTS,
  SKILL_TEMPLATE_SLUG_MAX,
  type ISkillListingTemplate,
} from '@bike4mind/common';
import { SkillScanFindingSchema } from './SkillListingVersionModel';

/**
 * A Skill Market listing's template page: author copy (headline, inputs, example prompt) shown on a
 * public page. It hangs off the listing, never the raw skill, so the page only exposes content that
 * passed the market scan. Publishing scans the copy with the same claim-stamp shape as a listing
 * version (SkillListingVersionModel): the verdict write is guarded on `scanClaimedAt`.
 */
export interface ISkillListingTemplateDocument extends Omit<ISkillListingTemplate, 'id'>, Document {
  id: string;
}

const SkillListingTemplateSchema = new Schema<ISkillListingTemplateDocument>(
  {
    listingId: { type: String, required: true },
    slug: { type: String, required: true, maxlength: SKILL_TEMPLATE_SLUG_MAX },
    headline: { type: String, default: '', maxlength: SKILL_TEMPLATE_HEADLINE_MAX },
    inputs: {
      type: [
        new Schema(
          {
            label: { type: String, required: true, maxlength: SKILL_TEMPLATE_INPUT_LABEL_MAX },
            required: { type: Boolean, default: false },
          },
          { _id: false }
        ),
      ],
      default: [],
      validate: {
        validator: (inputs: unknown[]) => inputs.length <= SKILL_TEMPLATE_MAX_INPUTS,
        message: `A template has at most ${SKILL_TEMPLATE_MAX_INPUTS} inputs`,
      },
    },
    examplePrompt: { type: String, default: '', maxlength: SKILL_TEMPLATE_EXAMPLE_PROMPT_MAX },
    previewImage: {
      type: new Schema(
        {
          fabFileId: { type: String, required: true },
          source: { type: String, required: true, enum: ['upload', 'generated'] },
          approved: { type: Boolean, default: false },
        },
        { _id: false }
      ),
      default: undefined,
    },
    status: { type: String, required: true, enum: ['draft', 'in_review', 'published'], default: 'draft' },
    freeRunEnabled: { type: Boolean, default: false },
    generatedFromVersionId: { type: String, default: null },
    stale: { type: Boolean, default: false },
    viewCount: { type: Number, default: 0 },
    freeRunCount: { type: Number, default: 0 },
    tryCount: { type: Number, default: 0 },
    // No default: the verdict write's `$min` sets it only while it is absent.
    firstPublishedAt: { type: Date },

    scanStatus: { type: String, enum: ['scanning', 'passed', 'failed', 'error'] },
    scanClaimedAt: { type: Date, default: null },
    scanFindings: { type: [SkillScanFindingSchema], default: [] },
    scanError: { type: String, maxlength: 500 },
    scanModel: { type: String },
    riskTier: { type: String, enum: ['clean', 'review', 'high'] },
  },
  {
    timestamps: true,
    collection: 'skill_listing_templates',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

SkillListingTemplateSchema.index({ listingId: 1 }, { unique: true });
SkillListingTemplateSchema.index({ slug: 1 }, { unique: true });

export const SkillListingTemplate: Model<ISkillListingTemplateDocument> =
  (mongoose.models.SkillListingTemplate as Model<ISkillListingTemplateDocument>) ??
  model<ISkillListingTemplateDocument>('SkillListingTemplate', SkillListingTemplateSchema);

export type SkillTemplateScanVerdictPatch = Pick<ISkillListingTemplate, 'scanStatus' | 'scanFindings'> &
  Partial<Pick<ISkillListingTemplate, 'scanError' | 'scanModel' | 'riskTier'>>;

/** Copy fields an author edit may write in the same update that claims the scan. */
export type SkillTemplateCopyPatch = Partial<
  Pick<ISkillListingTemplate, 'headline' | 'inputs' | 'examplePrompt' | 'generatedFromVersionId' | 'stale'>
>;

/**
 * Move the template from one of `from` to `in_review` for a publish scan, writing `copy` in the same
 * update so a live page never shows unscanned copy. Null when it is no longer in one of `from` or
 * `extraFilter` (e.g. the preview image the caller checked) no longer matches.
 */
export async function claimSkillTemplateScan(
  listingId: string,
  claimedAt: Date,
  from: ReadonlyArray<'draft' | 'published'>,
  copy: SkillTemplateCopyPatch = {},
  extraFilter: FilterQuery<ISkillListingTemplateDocument> = {}
) {
  return SkillListingTemplate.findOneAndUpdate(
    { ...extraFilter, listingId, status: { $in: from } },
    {
      $set: { ...copy, status: 'in_review', scanStatus: 'scanning', scanClaimedAt: claimedAt, scanFindings: [] },
      $unset: { scanError: 1, scanModel: 1, riskTier: 1 },
    },
    { new: true, runValidators: true }
  );
}

/**
 * Write the verdict only if `claimedAt` is still the template's claim: `published` on a pass (first
 * publish stamps `firstPublishedAt`), back to `draft` otherwise. Returns whether it landed.
 */
export async function writeSkillTemplateScanVerdict(
  listingId: string,
  claimedAt: Date,
  patch: SkillTemplateScanVerdictPatch,
  publish: boolean
): Promise<boolean> {
  const res = await SkillListingTemplate.updateOne(
    { listingId, status: 'in_review', scanClaimedAt: claimedAt },
    {
      $set: { ...patch, status: publish ? 'published' : 'draft', scanClaimedAt: null },
      ...(publish ? { $min: { firstPublishedAt: new Date() } } : {}),
    },
    { runValidators: true }
  );
  return res.modifiedCount > 0;
}

/** Return an abandoned `in_review` claim (older than `staleBefore`) to draft so the author can edit again. */
export async function releaseStaleSkillTemplateScan(listingId: string, staleBefore: Date): Promise<void> {
  await SkillListingTemplate.updateOne(
    { listingId, status: 'in_review', scanClaimedAt: { $lt: staleBefore } },
    {
      $set: { status: 'draft', scanClaimedAt: null, scanStatus: 'error', scanError: 'The safety scan did not finish' },
    },
    { runValidators: true }
  );
}

async function settleVoidedScan(listingId: string): Promise<void> {
  await SkillListingTemplate.updateOne(
    { listingId, status: 'draft', scanStatus: 'scanning' },
    { $set: { scanStatus: 'error', scanError: 'The safety scan was cancelled' } },
    { runValidators: true }
  );
}

/**
 * The author takes the page down. Also voids a publish scan in flight, since its verdict write is
 * guarded on `in_review`. False when the template was neither published nor in review.
 */
export async function unpublishSkillTemplate(listingId: string): Promise<boolean> {
  const res = await SkillListingTemplate.updateOne(
    { listingId, status: { $in: ['published', 'in_review'] } },
    { $set: { status: 'draft', scanClaimedAt: null } },
    { runValidators: true }
  );
  if (res.modifiedCount === 0) return false;
  await settleVoidedScan(listingId);
  return true;
}

/**
 * Lifecycle rule for a new listing version: flag the copy as possibly out of date. The author's copy
 * is never rewritten here; they regenerate or confirm it from the editor.
 */
export async function markListingTemplateStale(listingId: string): Promise<void> {
  await SkillListingTemplate.updateOne({ listingId, stale: false }, { $set: { stale: true } }, { runValidators: true });
}

/** Lifecycle rule for a withdrawn or deleted listing: unpublish the template and switch its free run off. */
export async function unpublishListingTemplate(listingId: string): Promise<void> {
  await SkillListingTemplate.updateOne(
    { listingId },
    { $set: { status: 'draft', freeRunEnabled: false, scanClaimedAt: null } },
    { runValidators: true }
  );
  await settleVoidedScan(listingId);
}

export default SkillListingTemplate;
