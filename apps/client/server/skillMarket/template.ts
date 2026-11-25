import type { FilterQuery, UpdateQuery } from 'mongoose';
import {
  SkillListingTemplate,
  SkillListingVersion,
  claimSkillTemplateScan,
  deleteListingTemplate,
  releaseStaleSkillTemplateScan,
  unpublishSkillTemplate,
  writeSkillTemplateScanVerdict,
  type ISkillListingTemplateDocument,
  type SkillTemplateCopyPatch,
} from '@bike4mind/database';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type ISkillListing,
  type ISkillListingTemplate,
  type ISkillScanFinding,
  type ISkillSnapshot,
  type ISkillTemplateExample,
  type ISkillTemplatePreviewImage,
  type SkillListingTemplateSummary,
  type SkillTemplateUpdate,
  skillTemplateFreeRunEligibility,
} from '@bike4mind/common';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';
import {
  findListing,
  isListingAuthor,
  loadMarketSettings,
  type MarketActor,
  type MarketSettings,
} from '@bike4mind/server-utils/skillMarket/market';
import { requireAudienceMembership } from './author';
import { reviewStatusFor, scanPublicText } from './scanRules';
import { SCAN_STALE_MS, scanSkillSnapshot, type ScanDeps, type SnapshotScan } from './submitVersion';
import { firstFreeTemplateSlug, templateSlugBase, validateTemplateSlug } from './templateSlug';

/**
 * A listing author's template page (SkillListingTemplateModel), shared by the routes under
 * pages/api/skills/market/[id]/template/*. Only the listing's author reaches any of it, with the same
 * author check as the other author actions (author.ts); admins get no bypass.
 */

export type TemplateScanDeps = ScanDeps & {
  /** Runs before a scan that a copy edit triggers: the scan-spend rate limit. */
  beforeScan?: () => Promise<void>;
};

const SLUG_CREATE_ATTEMPTS = 5;

const staleBefore = () => new Date(Date.now() - SCAN_STALE_MS);

export const plainTemplate = (doc: ISkillListingTemplateDocument): ISkillListingTemplate =>
  doc.toJSON() as unknown as ISkillListingTemplate;

export async function requireOwnListing(user: MarketActor, listingId: string): Promise<ISkillListing> {
  const listing = await findListing(listingId);
  if (!listing) throw new NotFoundError('Listing not found');
  if (!isListingAuthor(listing, user)) throw new ForbiddenError("Only the author can manage this listing's template");
  return listing;
}

/** Template pages exist only for a listing the market currently serves. */
export function requireLiveListing(listing: ISkillListing): void {
  if (!isLive(listing)) throw new ConflictError('Only an approved listing can have a template page');
}

export const isLive = (listing: ISkillListing): boolean =>
  listing.status === 'approved' && !!listing.currentApprovedVersionId && !listing.hiddenByReports;

async function reload(listingId: string): Promise<ISkillListingTemplate> {
  const doc = await SkillListingTemplate.findOne({ listingId });
  if (!doc) throw new NotFoundError('Template not found');
  return plainTemplate(doc);
}

const duplicateKeyOn = (error: unknown, field: string): boolean =>
  isDuplicateKeyError(error) &&
  Boolean((error as { keyPattern?: Record<string, unknown> }).keyPattern?.[field] !== undefined);

/** A live listing's approved version snapshot, the only content a template may be built or judged from. */
export async function approvedSnapshotOf(
  listing: ISkillListing
): Promise<{ snapshot: ISkillSnapshot; versionId: string }> {
  const versionId = String(listing.currentApprovedVersionId);
  const version = await SkillListingVersion.findById(versionId).lean();
  if (!version || version.listingId !== String(listing.id)) throw new NotFoundError('Approved version not found');
  return { snapshot: version.snapshot, versionId };
}

export async function approvedSnapshotForDraft(
  user: MarketActor,
  listingId: string
): Promise<{ snapshot: ISkillSnapshot; versionId: string }> {
  const listing = await requireOwnListing(user, listingId);
  requireLiveListing(listing);
  return approvedSnapshotOf(listing);
}

/** The skill name in slug form, with the first free numeric suffix when another template holds it. */
export async function suggestTemplateSlug(listingName: string): Promise<string> {
  const base = templateSlugBase(listingName);
  // `base` is [a-z0-9-] only, so it needs no regex escaping.
  const clashes = await SkillListingTemplate.find({ slug: { $regex: `^${base}(-[0-9]+)?$` } })
    .select('slug')
    .lean();
  return firstFreeTemplateSlug(base, new Set(clashes.map(t => t.slug)));
}

/**
 * The author's template, which must be a draft: preview image changes are only allowed there. The
 * scan covers the copy only; image moderation (isImageServeable, the approval gate) guards the image.
 */
export async function requireDraftTemplate(
  user: MarketActor,
  listingId: string,
  { live }: { live: boolean }
): Promise<{ listing: ISkillListing; template: ISkillListingTemplate }> {
  const listing = await requireOwnListing(user, listingId);
  if (live) requireLiveListing(listing);
  const id = String(listing.id);
  await releaseStaleSkillTemplateScan(id, staleBefore());
  const doc = await SkillListingTemplate.findOne({ listingId: id });
  if (!doc) throw new NotFoundError('Save the template first');
  if (doc.status !== 'draft') throw new ConflictError('Unpublish the template to change its image');
  return { listing, template: plainTemplate(doc) };
}

function copyPatch(input: SkillTemplateUpdate): SkillTemplateCopyPatch {
  return {
    ...(input.headline !== undefined ? { headline: input.headline } : {}),
    ...(input.inputs !== undefined ? { inputs: input.inputs.map(({ label, required }) => ({ label, required })) } : {}),
    ...(input.examplePrompt !== undefined ? { examplePrompt: input.examplePrompt } : {}),
    ...(input.takesFile !== undefined ? { takesFile: input.takesFile } : {}),
    // Naming the current version is the author regenerating or confirming the copy against it.
    ...(input.generatedFromVersionId !== undefined
      ? { generatedFromVersionId: input.generatedFromVersionId, stale: false }
      : {}),
  };
}

function copyChanged(existing: ISkillListingTemplate, patch: SkillTemplateCopyPatch): boolean {
  if (patch.headline !== undefined && patch.headline !== existing.headline) return true;
  if (patch.examplePrompt !== undefined && patch.examplePrompt !== existing.examplePrompt) return true;
  if (patch.inputs === undefined) return false;
  const before = existing.inputs.map(({ label, required }) => ({ label, required }));
  return JSON.stringify(before) !== JSON.stringify(patch.inputs);
}

async function createTemplate(
  listing: ISkillListing,
  patch: SkillTemplateCopyPatch,
  slug: string | undefined
): Promise<ISkillListingTemplateDocument> {
  const listingId = String(listing.id);
  for (let attempt = 0; attempt < SLUG_CREATE_ATTEMPTS; attempt += 1) {
    const candidate = slug ?? (await suggestTemplateSlug(listing.name));
    try {
      return await SkillListingTemplate.create({ listingId, slug: candidate, ...patch });
    } catch (error) {
      if (duplicateKeyOn(error, 'listingId')) throw new ConflictError('This listing already has a template');
      if (!duplicateKeyOn(error, 'slug')) throw error;
      if (slug !== undefined) throw new ConflictError('That link name is taken');
      // Another template took the derived slug between the read and the insert; derive again.
    }
  }
  throw new ConflictError('Could not pick a free link name. Choose one instead.');
}

/**
 * Create the template or edit its copy. The slug is checked here and frozen once the template has
 * been published. Editing a published template's copy re-runs the scan in the same write that moves
 * it to `in_review`, so the public page never shows unscanned copy.
 */
export async function saveOwnTemplate(
  user: MarketActor,
  listingId: string,
  input: SkillTemplateUpdate,
  deps: TemplateScanDeps
): Promise<ISkillListingTemplate> {
  const listing = await requireOwnListing(user, listingId);
  requireLiveListing(listing);
  const id = String(listing.id);
  if (input.slug !== undefined) validateTemplateSlug(input.slug);
  if (input.generatedFromVersionId !== undefined && input.generatedFromVersionId !== listing.currentApprovedVersionId) {
    throw new ConflictError('The listing has a newer approved version. Regenerate the draft and try again.');
  }
  const patch = copyPatch(input);

  await releaseStaleSkillTemplateScan(id, staleBefore());
  const doc = await SkillListingTemplate.findOne({ listingId: id });
  if (!doc) return plainTemplate(await createTemplate(listing, patch, input.slug));
  const existing = plainTemplate(doc);
  if (existing.status === 'in_review') {
    throw new ConflictError('The template is being scanned. Try again in a moment.');
  }

  const slugChange = input.slug !== undefined && input.slug !== existing.slug;
  if (slugChange && existing.firstPublishedAt) {
    throw new ConflictError('The link name cannot change after the template has been published');
  }

  if (existing.status === 'published' && copyChanged(existing, patch)) {
    await requireAudienceMembership(user.id, listing);
    if (!(patch.headline ?? existing.headline).trim())
      throw new BadRequestError('A published template needs a headline');
    await deps.beforeScan?.();
    const claimedAt = new Date();
    const claimed = await claimSkillTemplateScan(id, claimedAt, ['published'], patch);
    if (!claimed) throw new ConflictError('The template changed while saving. Reload and try again.');
    return runTemplateScan(listing, plainTemplate(claimed), claimedAt, deps);
  }

  // A published template's copy is unchanged on this path; a change takes the scan branch above.
  // `takesFile` is not shown as text, so it needs no scan.
  const set: SkillTemplateCopyPatch =
    existing.status === 'published'
      ? {
          ...(patch.generatedFromVersionId !== undefined
            ? { generatedFromVersionId: patch.generatedFromVersionId, stale: false }
            : {}),
          ...(patch.takesFile !== undefined ? { takesFile: patch.takesFile } : {}),
        }
      : patch;
  let updated: ISkillListingTemplateDocument | null;
  try {
    updated = await SkillListingTemplate.findOneAndUpdate(
      // The `firstPublishedAt` guard keeps a concurrent first publish from letting a rename through.
      { listingId: id, status: existing.status, ...(slugChange ? { firstPublishedAt: { $exists: false } } : {}) },
      { $set: { ...set, ...(slugChange ? { slug: input.slug } : {}) } },
      { new: true, runValidators: true }
    );
  } catch (error) {
    if (duplicateKeyOn(error, 'slug')) throw new ConflictError('That link name is taken');
    throw error;
  }
  if (!updated) throw new ConflictError('The template changed while saving. Reload and try again.');
  return plainTemplate(updated);
}

export async function deleteOwnTemplate(user: MarketActor, listingId: string): Promise<void> {
  const listing = await requireOwnListing(user, listingId);
  const removed = await deleteListingTemplate(String(listing.id));
  if (removed === 0) throw new NotFoundError('Template not found');
}

/** Scan the draft's copy and shown example and publish them on a pass. A failing scan leaves it a draft with the findings. */
export async function publishOwnTemplate(
  user: MarketActor,
  listingId: string,
  deps: ScanDeps
): Promise<ISkillListingTemplate> {
  const listing = await requireOwnListing(user, listingId);
  requireLiveListing(listing);
  await requireAudienceMembership(user.id, listing);
  const id = String(listing.id);
  await releaseStaleSkillTemplateScan(id, staleBefore());
  const doc = await SkillListingTemplate.findOne({ listingId: id });
  if (!doc) throw new NotFoundError('Template not found');
  if (doc.status === 'published') throw new ConflictError('The template is already published');
  if (doc.status === 'in_review') throw new ConflictError('The template is already being scanned');
  if (!doc.headline.trim()) throw new BadRequestError('Add a headline before publishing');
  if (doc.previewImage && !doc.previewImage.approved) {
    throw new BadRequestError('Approve the preview image before publishing');
  }

  const claimedAt = new Date();
  // Pins the image checked above so a concurrent image change makes the claim fail.
  const imageGuard = doc.previewImage
    ? { 'previewImage.fabFileId': doc.previewImage.fabFileId, 'previewImage.approved': true }
    : { previewImage: { $exists: false } };
  const claimed = await claimSkillTemplateScan(id, claimedAt, ['draft'], {}, imageGuard);
  if (!claimed) throw new ConflictError('The template changed while publishing. Reload and try again.');
  return runTemplateScan(listing, plainTemplate(claimed), claimedAt, deps);
}

/**
 * Switch the free run on or off. Turning it on needs a live listing whose approved version can run
 * without tools or files (skillTemplateFreeRunEligibility); turning it off is always allowed.
 */
export async function setOwnTemplateFreeRun(
  user: MarketActor,
  listingId: string,
  enabled: boolean
): Promise<ISkillListingTemplate> {
  const listing = await requireOwnListing(user, listingId);
  const id = String(listing.id);
  if (enabled) {
    requireLiveListing(listing);
    const eligibility = skillTemplateFreeRunEligibility((await approvedSnapshotOf(listing)).snapshot);
    if (!eligibility.eligible) throw new ConflictError(eligibility.reason);
  }
  await releaseStaleSkillTemplateScan(id, staleBefore());
  const updated = await SkillListingTemplate.findOneAndUpdate(
    { listingId: id, status: { $ne: 'in_review' } },
    { $set: { freeRunEnabled: enabled } },
    { new: true, runValidators: true }
  );
  if (updated) return plainTemplate(updated);
  if (!(await SkillListingTemplate.exists({ listingId: id }))) throw new NotFoundError('Template not found');
  throw new ConflictError('The template is being scanned. Try again in a moment.');
}

/**
 * Write a change to the stored example. When `shown` matches a published (or in-review) template,
 * the change lands in the same update that claims a fresh scan, as a copy edit does
 * (saveOwnTemplate), so the public page never shows an unscanned example; the scan then runs and an
 * earlier in-flight verdict is voided by the new claim. Null when `match` no longer holds.
 */
export async function writeTemplateExample(
  listingId: string,
  match: FilterQuery<ISkillListingTemplateDocument>,
  change: { $set: Record<string, unknown>; $unset?: Record<string, 1> },
  shown: FilterQuery<ISkillListingTemplateDocument> | null,
  deps: ScanDeps
): Promise<ISkillListingTemplate | null> {
  const live: FilterQuery<ISkillListingTemplateDocument> = { status: { $in: ['published', 'in_review'] }, ...shown };
  // Two passes: the template can be published or unpublished between them.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (shown) {
      const claimedAt = new Date();
      const claimed = await SkillListingTemplate.findOneAndUpdate(
        { ...match, ...live, listingId },
        {
          $set: {
            ...change.$set,
            status: 'in_review',
            scanStatus: 'scanning',
            scanClaimedAt: claimedAt,
            scanFindings: [],
          },
          $unset: { ...change.$unset, scanError: 1, scanModel: 1, riskTier: 1 },
        },
        { new: true, runValidators: true }
      );
      if (claimed) return scanClaimedExample(listingId, plainTemplate(claimed), claimedAt, deps);
    }
    const update: UpdateQuery<ISkillListingTemplateDocument> = { $set: change.$set };
    if (change.$unset) update.$unset = change.$unset;
    const quiet = await SkillListingTemplate.findOneAndUpdate(
      { ...match, listingId, ...(shown ? { $nor: [live] } : {}) },
      update,
      { new: true, runValidators: true }
    );
    if (quiet) return plainTemplate(quiet);
  }
  return null;
}

async function scanClaimedExample(
  listingId: string,
  template: ISkillListingTemplate,
  claimedAt: Date,
  deps: ScanDeps
): Promise<ISkillListingTemplate> {
  const listing = await findListing(listingId);
  if (!listing || !isLive(listing)) {
    await writeSkillTemplateScanVerdict(
      listingId,
      claimedAt,
      { scanStatus: 'error', scanFindings: [], scanError: 'The listing is no longer live' },
      false
    );
    return reload(listingId);
  }
  return runTemplateScan(listing, template, claimedAt, deps);
}

/** Each listing's template slug and status in one query; a listing with no template is absent. */
export async function templateSummariesByListing(
  listingIds: string[]
): Promise<Map<string, SkillListingTemplateSummary>> {
  if (listingIds.length === 0) return new Map();
  const rows = await SkillListingTemplate.find({ listingId: { $in: listingIds } })
    .select('listingId slug status')
    .lean();
  return new Map(rows.map(row => [row.listingId, { slug: row.slug, status: row.status }]));
}

export async function unpublishOwnTemplate(user: MarketActor, listingId: string): Promise<ISkillListingTemplate> {
  const listing = await requireOwnListing(user, listingId);
  const id = String(listing.id);
  if (!(await unpublishSkillTemplate(id))) {
    if (!(await SkillListingTemplate.exists({ listingId: id }))) throw new NotFoundError('Template not found');
    throw new ConflictError('The template is not published');
  }
  return reload(id);
}

type ScannedCopy = Pick<ISkillListingTemplate, 'headline' | 'inputs' | 'examplePrompt'> &
  Partial<Pick<ISkillListingTemplate, 'example'>>;

/** The example content a public page shows: nothing while the author has the demo switched off. */
export function templateExampleScanFields(
  example: ISkillTemplateExample | null | undefined
): Array<{ label: string; text: string }> {
  if (!example?.enabled) return [];
  const reply = example.replyTrimmedTo ? example.reply.slice(0, example.replyTrimmedTo) : example.reply;
  const artifactText = (example.artifact?.html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [
    { label: 'Example run prompt', text: example.prompt },
    { label: 'Example sample file', text: example.sampleFile?.name ?? '' },
    ...example.steps.map(step => ({ label: 'Example step', text: step.label })),
    { label: 'Example reply', text: reply },
    { label: 'Example artifact title', text: example.artifact?.title ?? '' },
    { label: 'Example artifact', text: artifactText },
  ].filter(field => field.text.trim());
}

/** The template copy and shown example in snapshot form, so they run through the market scan unchanged (scanSkillSnapshot). */
export function templateScanSnapshot(listing: Pick<ISkillListing, 'name'>, copy: ScannedCopy): ISkillSnapshot {
  return {
    name: listing.name,
    description: copy.headline,
    body: [
      `Headline: ${copy.headline}`,
      ...copy.inputs.map(input => `Input${input.required ? ' (required)' : ''}: ${input.label}`),
      `Example prompt: ${copy.examplePrompt}`,
      ...templateExampleScanFields(copy.example).map(field => `${field.label}: ${field.text}`),
    ].join('\n'),
    disableModelInvocation: false,
  };
}

/**
 * Where a preview-image scan plugs into the template scan. The market scan has no image path, so an
 * image adds no findings yet.
 */
export async function scanTemplatePreviewImage(
  _image: ISkillTemplatePreviewImage | null | undefined
): Promise<ISkillScanFinding[]> {
  return [];
}

const onePerRule = (findings: ISkillScanFinding[]) => [...new Map(findings.map(f => [f.rule, f])).values()];

/**
 * The market scan over the template copy, the shown example run and the preview image. Every field
 * is shown on a public page, so each also gets the public-text rules (links, markup, hidden
 * characters), one finding per rule; example findings carry an `example_` rule and say which part.
 */
export async function scanTemplate(
  listing: Pick<ISkillListing, 'name'>,
  template: ScannedCopy & Pick<ISkillListingTemplate, 'previewImage'>,
  settings: MarketSettings,
  getClassifier: ScanDeps['getClassifier']
): Promise<SnapshotScan> {
  const fields = [template.headline, ...template.inputs.map(input => input.label), template.examplePrompt];
  const publicFindings = onePerRule(fields.flatMap(field => scanPublicText(field, settings.urlAllowlist)));
  const exampleFindings = onePerRule(
    templateExampleScanFields(template.example).flatMap(({ label, text }) =>
      scanPublicText(text, settings.urlAllowlist).map(f => ({
        ...f,
        rule: `example_${f.rule}`,
        message: `${label}: ${f.message}`,
      }))
    )
  );
  const imageFindings = await scanTemplatePreviewImage(template.previewImage);
  return scanSkillSnapshot(templateScanSnapshot(listing, template), settings, getClassifier, [
    ...publicFindings,
    ...exampleFindings,
    ...imageFindings,
  ]);
}

/**
 * Scan the claimed copy and write the verdict. Templates have no human review step, so only a result
 * the market would publish without a reviewer goes live (the global-skill bar, globalSkillUpdate.ts);
 * anything else returns to draft with its findings, and an errored scan fails closed.
 */
async function runTemplateScan(
  listing: ISkillListing,
  template: ISkillListingTemplate,
  claimedAt: Date,
  deps: ScanDeps
): Promise<ISkillListingTemplate> {
  const id = String(listing.id);
  const settings = deps.settings ?? (await loadMarketSettings());
  const scan = await scanTemplate(listing, template, settings, deps.getClassifier);

  if (scan.status === 'error') {
    await writeSkillTemplateScanVerdict(
      id,
      claimedAt,
      { scanStatus: 'error', scanFindings: scan.findings, scanError: scan.error, scanModel: scan.model },
      false
    );
    return reload(id);
  }

  const passed = scan.tier !== 'failed' && reviewStatusFor(scan.tier, listing.visibility) === 'auto_approved';
  // The listing can be withdrawn or delisted while the scan runs.
  const current = await findListing(id);
  const live = current !== null && isLive(current);
  await writeSkillTemplateScanVerdict(
    id,
    claimedAt,
    {
      scanStatus: passed ? 'passed' : 'failed',
      scanFindings: scan.findings,
      ...(scan.tier !== 'failed' ? { riskTier: scan.tier } : {}),
      ...(scan.classifier ? { scanModel: scan.classifier.model } : {}),
    },
    passed && live
  );
  if (passed && !live) throw new ConflictError('The listing is no longer live, so the template was not published');
  return reload(id);
}
