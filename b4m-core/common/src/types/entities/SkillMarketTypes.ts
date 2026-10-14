/**
 * Skill Market: users publish one of their skills as a listing, every version is safety-scanned,
 * and other users browse, import (a copy of the approved snapshot) and rate it.
 *
 * Only `currentApprovedVersionId` content is ever served to non-authors; pending/rejected versions
 * are readable by the author and reviewers only (apps/client/server/skillMarket/access.ts).
 */

export type SkillListingVisibility = 'public' | 'organization' | 'unlisted';

export type SkillListingStatus = 'in_review' | 'approved' | 'rejected' | 'delisted' | 'withdrawn';

export type SkillScanStatus = 'scanning' | 'passed' | 'failed' | 'error';

export type SkillReviewStatus = 'not_required' | 'pending' | 'auto_approved' | 'approved' | 'rejected' | 'superseded';

/** Risk tier assigned by a passed scan; drives whether a human must approve. */
export type SkillRiskTier = 'clean' | 'review' | 'high';

/** `critical` fails the scan; `high` / `medium` raise the tier; `low` is informational. */
export type SkillScanSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ISkillScanFinding {
  rule: string;
  severity: SkillScanSeverity;
  message: string;
  excerpt?: string;
  source: 'rules' | 'classifier';
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

/** The skill fields a version freezes. */
export interface ISkillSnapshot {
  name: string;
  description: string;
  body: string;
  argumentHint?: string;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
}

export interface ISkillListing {
  id: string;
  sourceSkillId: string;
  authorUserId: string;
  authorName?: string;
  visibility: SkillListingVisibility;
  organizationId?: string;
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
  reminderSentAt?: Date | null;

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
  state: 'current' | 'stale' | 'delisted' | 'removed';
  importedVersion: number;
  latestVersion?: number;
  locallyModified: boolean;
}
