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

export interface ISkillTemplateInput {
  label: string;
  required: boolean;
}

export interface ISkillTemplatePreviewImage {
  fabFileId: string;
  source: 'upload' | 'generated';
}

export interface ISkillListingTemplate {
  id: string;
  listingId: string;
  slug: string;
  headline: string;
  inputs: ISkillTemplateInput[];
  examplePrompt: string;
  previewImage?: ISkillTemplatePreviewImage | null;
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
export type SkillTemplateDraft = Pick<ISkillListingTemplate, 'headline' | 'inputs' | 'examplePrompt'>;

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
  /** The listing's current approved version: the copy was (re)drafted from it or reviewed against it. */
  generatedFromVersionId: z.string().min(1).optional(),
});
export type SkillTemplateUpdate = z.infer<typeof SkillTemplateUpdateSchema>;
