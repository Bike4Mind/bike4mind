import { z } from 'zod';

/**
 * Skill Market: users publish one of their skills as a listing, every version is safety-scanned,
 * and other users browse, import (a copy of the approved snapshot) and rate it.
 *
 * Only `currentApprovedVersionId` content is ever served to non-authors; pending/rejected versions
 * are readable by the author and reviewers only (packages/server-utils/src/skillMarket/market.ts).
 */

export type SkillListingVisibility = 'public' | 'organization' | 'space' | 'unlisted';

export type SkillListingStatus = 'in_review' | 'approved' | 'rejected' | 'delisted' | 'withdrawn';

export type SkillScanStatus = 'scanning' | 'passed' | 'failed' | 'error';

export type SkillReviewStatus = 'not_required' | 'pending' | 'auto_approved' | 'approved' | 'rejected' | 'superseded';

/** Risk tier assigned by a passed scan; drives whether a human must approve. */
export type SkillRiskTier = 'clean' | 'review' | 'high';

/** A listing tag. Shared by the web PublishDialog, the server's validateListingTags and desktop. */
export const SKILL_LISTING_TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const SKILL_LISTING_MAX_TAGS = 5;

/** Request header carrying an unlisted listing's share token to the listing detail routes. */
export const SKILL_SHARE_TOKEN_HEADER = 'x-share-token';

/** `critical` fails the scan; `high` / `medium` raise the tier; `low` is informational. */
export type SkillScanSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ISkillScanFinding {
  rule: string;
  severity: SkillScanSeverity;
  message: string;
  excerpt?: string;
  source: 'rules' | 'classifier';
  /** Supporting file the finding is in; absent for the SKILL.md fields. */
  file?: string;
}

/** Machine-generated from the body + allowedTools, never from the author's description. */
export interface ISkillHonestSummary {
  whatItDoes: string;
  toolsUsed: string[];
  dataItTouches: string;
  riskNotes: string[];
  descriptionMatches: boolean;
  mismatchNote?: string;
}

/** A UTF-8 text file shipped beside SKILL.md, at a path under `scripts/` or `references/` (utils/skillFiles.ts). */
export interface ISkillFile {
  path: string;
  content: string;
}

/** The skill fields a version freezes. */
export interface ISkillSnapshot {
  name: string;
  description: string;
  body: string;
  argumentHint?: string;
  allowedTools?: string[];
  claudeCodeAllowedTools?: string[];
  claudeCodeModel?: string;
  disableModelInvocation?: boolean;
  /** Sorted by path; absent when the skill has none. */
  files?: ISkillFile[];
}

export interface ISkillListing {
  id: string;
  sourceSkillId: string;
  authorUserId: string;
  authorName?: string;
  visibility: SkillListingVisibility;
  organizationId?: string;
  spaceId?: string;
  tags: string[];
  status: SkillListingStatus;
  /** Unguessable token for unlisted links (192 bits). Never returned to non-authors of public/org listings. */
  shareToken: string;
  currentApprovedVersionId?: string | null;
  currentVersion?: number | null;
  pendingVersionId?: string | null;
  pendingVersion?: number | null;
  /** Monotonic counter used to number new versions. */
  latestVersion: number;
  /** Organization and Space listings' Claude Code plugin name: assigned at first approval, never changed. */
  claudePluginName?: string;

  // Denormalized from the current approved version so browse/search/cards read only the listing.
  name: string;
  description: string;
  honestSummaryText?: string;
  descriptionMatches?: boolean;
  usesTools?: boolean;
  riskTier?: SkillRiskTier;
  /** True when the live version went out without a human (auto-approved). */
  autoChecked?: boolean;
  publishedAt?: Date | null;

  importCount: number;
  ratingSum: number;
  ratingCount: number;

  /** Hidden from the market after enough distinct reports, until an admin restores or delists it. */
  hiddenByReports?: boolean;
  delistedReason?: string;
  /** Set on a super-admin takedown, which only a super-admin may reverse. */
  delistedBySuperAdmin?: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface ISkillListingVersion {
  id: string;
  listingId: string;
  version: number;
  snapshot: ISkillSnapshot;
  contentHash: string;

  scanStatus: SkillScanStatus;
  scanClaimedAt?: Date | null;
  scanFindings: ISkillScanFinding[];
  scanModel?: string;
  scanError?: string;
  riskTier?: SkillRiskTier;
  honestSummary?: ISkillHonestSummary;

  reviewStatus: SkillReviewStatus;
  reviewerUserId?: string;
  reviewNote?: string;
  reviewedAt?: Date;
  reviewAckMismatch?: boolean;
  reviewAckHighRisk?: boolean;

  /** Auto-approved versions picked for the admin random-sample audit. */
  auditSample?: boolean;
  auditedAt?: Date | null;
  /** Who audited it; `reviewerUserId` stays the original approver. */
  auditedByUserId?: string;
  reminderSentAt?: Date | null;
  /** SLA reminders sent so far; capped so a stuck review does not page reviewers forever. */
  reminderCount?: number;

  createdAt: Date;
  updatedAt: Date;
}

/** An org's or Space's curated set of its listings, served as one Claude Code plugin in its feed. Exactly one owner. */
export interface ISkillBundle {
  id: string;
  organizationId?: string;
  spaceId?: string;
  name: string;
  description: string;
  /** Claude Code plugin name, unique in the org feed alongside listings' `claudePluginName`. */
  pluginName: string;
  /** Member listings in the admin's order; the zip orders skills by directory name instead. */
  listingIds: string[];
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One row per (listing, importer). Also carries the importer's rating, so rating requires an import. */
export interface ISkillListingImport {
  id: string;
  listingId: string;
  userId: string;
  skillId: string;
  version: number;
  importedAt: Date;
  stars?: number;
  review?: string;
  ratedAt?: Date;
}

export type SkillListingReportReason = 'malicious' | 'spam' | 'misleading' | 'abuse' | 'copyright' | 'other';

export interface ISkillListingReport {
  id: string;
  listingId: string;
  reporterId: string;
  reason: SkillListingReportReason;
  details?: string;
  /** False for a brand-new account that hasn't imported the listing: kept for moderators, not counted toward auto-hide. */
  countsTowardHide?: boolean;
  status: 'open' | 'actioned' | 'dismissed';
  resolvedBy?: string | null;
  resolvedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Provenance stamped on a skill created by importing a listing. */
export interface ISkillImportedFrom {
  listingId: string;
  versionId: string;
  version: number;
  /** Hash of the imported snapshot; differs from the copy's current hash once the importer edits it. */
  contentHash: string;
}

/** Server-computed on GET /api/skills and /api/skills/[id] for imported copies. */
export interface ISkillMarketStatus {
  state: 'current' | 'stale' | 'delisted' | 'removed' | 'hidden';
  importedVersion: number;
  latestVersion?: number;
  locallyModified: boolean;
}

/** A listing's shareable template page. Its copy is scanned with the market scan before it is published. */
export type SkillTemplateStatus = 'draft' | 'in_review' | 'published';

export const SKILL_TEMPLATE_MAX_INPUTS = 3;
export const SKILL_TEMPLATE_HEADLINE_MAX = 120;
export const SKILL_TEMPLATE_INPUT_LABEL_MAX = 60;
export const SKILL_TEMPLATE_EXAMPLE_PROMPT_MAX = 2000;
export const SKILL_TEMPLATE_SLUG_MAX = 64;
/** Slugs that would read as a site path under the template page prefix. */
export const SKILL_TEMPLATE_RESERVED_SLUGS: readonly string[] = [
  'admin',
  'api',
  'app',
  'b4m',
  'bike4mind',
  'help',
  'login',
  'logout',
  'new',
  'settings',
  'signup',
  'support',
];

/** Same shape as a skill name (server/utils/skillValidation.ts SKILL_NAME_PATTERN). */
export const SKILL_TEMPLATE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Why an author-chosen slug is refused, or null when it is usable. The editor and the server share it. */
export function skillTemplateSlugProblem(slug: string): string | null {
  if (slug.length > SKILL_TEMPLATE_SLUG_MAX || !SKILL_TEMPLATE_SLUG_PATTERN.test(slug)) {
    return 'The link name must be lowercase letters, digits and hyphens, and cannot start or end with a hyphen';
  }
  if (SKILL_TEMPLATE_RESERVED_SLUGS.includes(slug)) return 'That link name is reserved';
  return null;
}

/** Every preview image is stored at exactly this size: the page sample and the link-preview card. */
export const SKILL_TEMPLATE_IMAGE_WIDTH = 1200;
export const SKILL_TEMPLATE_IMAGE_HEIGHT = 630;
/** Bytes. The largest screenshot or generated image the server normalizes. */
export const SKILL_TEMPLATE_IMAGE_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
/** Source formats the server's image decoder reads. */
export const SKILL_TEMPLATE_IMAGE_SOURCE_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg'];
/** Longest pasted result an image generation prompt is built from. */
export const SKILL_TEMPLATE_IMAGE_RESULT_MAX = 4000;

export interface ISkillTemplateInput {
  label: string;
  required: boolean;
}

export interface ISkillTemplatePreviewImage {
  fabFileId: string;
  source: 'upload' | 'generated';
  /** The author approved this exact image; a new image always starts unapproved. */
  approved: boolean;
}

/** Example runs one author may start per UTC day, across all their templates. */
export const SKILL_TEMPLATE_EXAMPLE_DAILY_RUN_CAP = 5;
/** Longest stored example reply, in characters; a longer reply is cut. */
export const SKILL_TEMPLATE_EXAMPLE_REPLY_MAX = 8000;
/** Tool steps stored per example run, and the longest step line. */
export const SKILL_TEMPLATE_EXAMPLE_STEPS_MAX = 12;
export const SKILL_TEMPLATE_EXAMPLE_STEP_LABEL_MAX = 80;
/** Longest rendered artifact kept, in characters of sanitized HTML; a larger one makes the example chat-only. */
export const SKILL_TEMPLATE_EXAMPLE_ARTIFACT_HTML_MAX = 200_000;
export const SKILL_TEMPLATE_EXAMPLE_ARTIFACT_TITLE_MAX = 120;
/** Media caps. Media over a cap is dropped, never re-encoded. Seconds and bytes. */
export const SKILL_TEMPLATE_EXAMPLE_VIDEO_MAX_SECONDS = 30;
export const SKILL_TEMPLATE_EXAMPLE_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export const SKILL_TEMPLATE_EXAMPLE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const SKILL_TEMPLATE_EXAMPLE_CAROUSEL_MAX_SLIDES = 10;

export type SkillTemplateExampleStatus = 'running' | 'ready' | 'failed';

/** One tool call of the example run, as a short line; `simulated` when the dry run faked the result. */
export interface ISkillTemplateExampleStep {
  label: string;
  simulated: boolean;
}

/** The run's first artifact as a sanitized, read-only HTML render made server-side. */
export interface ISkillTemplateExampleArtifact {
  type: string;
  title: string;
  html: string;
}

export interface ISkillTemplateExampleMediaItem {
  /** Storage key of the generated file. */
  key: string;
  mime: string;
  bytes: number;
  durationS?: number;
  width?: number;
  height?: number;
  /**
   * An image's check by the platform image moderation gate, recorded at harvest. A generated image has
   * no FabFile row, so this is its only verdict; anything but 'clean' never shows on a template page.
   */
  moderation?: SkillTemplateExampleImageModeration;
}

export const SKILL_TEMPLATE_EXAMPLE_IMAGE_MODERATION = ['clean', 'blocked', 'error'] as const;
export type SkillTemplateExampleImageModeration = (typeof SKILL_TEMPLATE_EXAMPLE_IMAGE_MODERATION)[number];

export interface ISkillTemplateExampleMedia {
  kind: 'video' | 'image' | 'carousel';
  items: ISkillTemplateExampleMediaItem[];
}

/** The file the example prompt was run on, for skills that take one. Metadata only on the page. */
export interface ISkillTemplateExampleSampleFile {
  name: string;
  mime: string;
  pages?: number;
  source: 'generated' | 'upload';
  /** An author-owned FabFile. */
  fabFileId?: string;
}

/**
 * A run of the skill on the example prompt, made by the platform (server/skillMarket/templateExample.ts).
 * The author can trim the reply or switch the demo off, never write the reply or artifact.
 */
export interface ISkillTemplateExample {
  status: SkillTemplateExampleStatus;
  /** The author's switch; off shows the page without the demo. */
  enabled: boolean;
  prompt: string;
  reply: string;
  /** Characters of `reply` the page shows; null shows all of it. */
  replyTrimmedTo?: number | null;
  artifact?: ISkillTemplateExampleArtifact | null;
  media?: ISkillTemplateExampleMedia | null;
  sampleFile?: ISkillTemplateExampleSampleFile | null;
  steps: ISkillTemplateExampleStep[];
  /** The approved listing version the run used. */
  generatedFromVersionId?: string | null;
  runAt?: Date;
  error?: string;
}

export interface ISkillListingTemplate {
  id: string;
  listingId: string;
  slug: string;
  headline: string;
  inputs: ISkillTemplateInput[];
  examplePrompt: string;
  previewImage?: ISkillTemplatePreviewImage | null;
  /** The skill works on an attached file, so the page shows a file card and a paperclip. */
  takesFile?: boolean;
  example?: ISkillTemplateExample | null;
  status: SkillTemplateStatus;
  freeRunEnabled: boolean;
  /** The approved listing version the copy was last drafted from or confirmed against. */
  generatedFromVersionId?: string | null;
  /** A newer listing version exists than the one the copy was written for. */
  stale: boolean;
  viewCount: number;
  freeRunCount: number;
  tryCount: number;
  /** Set by the first passing publish; the slug is frozen from then on. */
  firstPublishedAt?: Date;
  scanStatus?: SkillScanStatus | null;
  scanClaimedAt?: Date | null;
  scanFindings: ISkillScanFinding[];
  scanError?: string;
  scanModel?: string;
  riskTier?: SkillRiskTier;
  createdAt: Date;
  updatedAt: Date;
}

/** The copy the draft endpoint proposes; every field is empty when drafting fails. */
export type SkillTemplateDraft = Pick<ISkillListingTemplate, 'headline' | 'inputs' | 'examplePrompt'> & {
  takesFile?: boolean;
};

export const SkillTemplateInputSchema = z.object({
  label: z.string().trim().min(1).max(SKILL_TEMPLATE_INPUT_LABEL_MAX),
  required: z.boolean().default(false),
});

/**
 * Body of PUT /api/skills/market/[id]/template. Status, counters, the free-run switch and the preview
 * image are not author-writable here; the slug's shape is checked server-side (templateSlug.ts).
 */
export const SkillTemplateUpdateSchema = z.strictObject({
  slug: z.string().trim().min(1).max(SKILL_TEMPLATE_SLUG_MAX).optional(),
  headline: z.string().trim().max(SKILL_TEMPLATE_HEADLINE_MAX).optional(),
  inputs: z.array(SkillTemplateInputSchema).max(SKILL_TEMPLATE_MAX_INPUTS).optional(),
  examplePrompt: z.string().trim().max(SKILL_TEMPLATE_EXAMPLE_PROMPT_MAX).optional(),
  takesFile: z.boolean().optional(),
  /** The listing's current approved version: the copy was (re)drafted from it or reviewed against it. */
  generatedFromVersionId: z.string().min(1).optional(),
});
export type SkillTemplateUpdate = z.infer<typeof SkillTemplateUpdateSchema>;

/** PUT /api/skills/market/[id]/template/image: a screenshot the author uploaded as a file. */
export const SkillTemplateImageUploadSchema = z.strictObject({ fabFileId: z.string().min(1).max(64) });

/** POST /api/skills/market/[id]/template/image/generate: a real result to illustrate. */
export const SkillTemplateImageGenerateSchema = z.strictObject({
  result: z.string().trim().min(1).max(SKILL_TEMPLATE_IMAGE_RESULT_MAX),
});

/** POST /api/skills/market/[id]/template/image/from-generation: the finished image generation to use. */
export const SkillTemplateImageFromGenerationSchema = z.strictObject({ questId: z.string().min(1).max(64) });

/** POST /api/skills/market/[id]/template/example: run (or re-run) the example; defaults to the template's example prompt. */
export const SkillTemplateExampleRunSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(SKILL_TEMPLATE_EXAMPLE_PROMPT_MAX).optional(),
});
export type SkillTemplateExampleRun = z.infer<typeof SkillTemplateExampleRunSchema>;

/**
 * PUT /api/skills/market/[id]/template/example. Trimming can only shorten the stored reply; nothing
 * here writes reply or artifact text. A null sample file id goes back to a generated sample.
 */
export const SkillTemplateExampleUpdateSchema = z.strictObject({
  enabled: z.boolean().optional(),
  replyTrimmedTo: z.number().int().min(1).max(SKILL_TEMPLATE_EXAMPLE_REPLY_MAX).nullable().optional(),
  sampleFabFileId: z.string().min(1).max(64).nullable().optional(),
});
export type SkillTemplateExampleUpdate = z.infer<typeof SkillTemplateExampleUpdateSchema>;

/** PUT /api/skills/market/[id]/template/free-run. */
export const SkillTemplateFreeRunSchema = z.strictObject({ enabled: z.boolean() });

export type SkillTemplateFreeRunEligibility = { eligible: true } | { eligible: false; reason: string };

/**
 * Whether a skill can offer the anonymous free run. That run is one completion with no tools and no
 * files, so a skill that declares tools or ships supporting files would not work as written.
 */
export function skillTemplateFreeRunEligibility(
  snapshot: Pick<ISkillSnapshot, 'allowedTools' | 'claudeCodeAllowedTools' | 'files'>
): SkillTemplateFreeRunEligibility {
  if (snapshot.allowedTools?.length || snapshot.claudeCodeAllowedTools?.length) {
    return { eligible: false, reason: 'This skill uses tools, so it cannot offer a free run.' };
  }
  if (snapshot.files?.length) {
    return { eligible: false, reason: 'This skill needs supporting files, so it cannot offer a free run.' };
  }
  return { eligible: true };
}

/** The public template page. */
export const skillTemplatePagePath = (slug: string): string => `/t/${encodeURIComponent(slug)}`;

/**
 * `localStorage` key for the text a visitor typed into a template page's free run. The page writes it
 * and the try route (`/skills/market/try/$slug`) reads it as the chat prompt, then removes it.
 */
export const skillTemplateFreeRunInputKey = (slug: string): string => `b4m.skillTemplate.freeRunInput.${slug}`;

/**
 * The public, cacheable preview image URL. The file id busts link-preview and CDN caches when the
 * author replaces the image.
 */
export const skillTemplatePreviewImagePath = (slug: string, fabFileId: string): string =>
  `/api/skills/template/image/${encodeURIComponent(slug)}?v=${encodeURIComponent(fabFileId)}`;

/** The author's preview of their template page, drafts included (owner only, Bearer token). */
export const skillTemplatePreviewPath = (listingId: string): string =>
  `/api/skills/market/${encodeURIComponent(listingId)}/template/preview`;

/** What GET /api/skills/market/mine shows of a listing's template. */
export type SkillListingTemplateSummary = Pick<ISkillListingTemplate, 'slug' | 'status'>;

/** `pending` until the file passes moderation; `missing` once the author deleted the file. */
export type SkillTemplatePreviewImageStatus = 'pending' | 'ready' | 'blocked' | 'missing';

/** GET /api/skills/market/[id]/template: the template plus what the editor needs around it. */
export interface SkillTemplateEditorView {
  template: ISkillListingTemplate | null;
  listing: { id: string; name: string; visibility: SkillListingVisibility; live: boolean };
  currentApprovedVersionId: string | null;
  /** Null when the listing has no approved version to judge. */
  eligibility: SkillTemplateFreeRunEligibility | null;
  /** The slug a first save would derive; null once a template exists. */
  suggestedSlug: string | null;
  /** A short-lived URL for the editor to show the image; null until it passes moderation. */
  previewImageUrl: string | null;
  previewImageStatus: SkillTemplatePreviewImageStatus | null;
  /** Example runs the author can still start today, across all their templates. */
  exampleRunsLeftToday: number;
}
