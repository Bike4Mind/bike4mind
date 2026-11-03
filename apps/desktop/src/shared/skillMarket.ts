import type {
  ISkillFile,
  ISkillHonestSummary,
  ISkillSnapshot,
  SkillListingStatus,
  SkillListingVisibility,
  SkillReviewStatus,
  SkillRiskTier,
} from '@bike4mind/common';
import type { ChatDiff } from './chat';

/**
 * The Skill Market as the renderer sees it. Every read and the import go through main
 * (SkillMarket.ts), which owns the HTTP and the account's skill cache. Unlike the picker's
 * SkillSummary, a listing's body DOES cross here: the detail view shows it read-only so the
 * user can see what they import. It never reaches the run path from the renderer.
 */

/** A card in the browse grid. Mirrors the web's MarketListing, narrowed to what is drawn. */
export interface SkillMarketListing {
  id: string;
  name: string;
  description: string;
  authorName?: string;
  visibility: SkillListingVisibility;
  status: string;
  tags: string[];
  ratingAvg: number;
  ratingCount: number;
  importCount: number;
  riskTier?: SkillRiskTier;
  usesTools?: boolean;
  /** Set on a recommendation: why it was suggested. */
  reason?: string;
}

/** The web's browse filters (apps/client/app/hooks/data/skillMarket.ts MarketFilters). */
export interface SkillMarketFilters {
  q: string;
  scope: '' | 'public' | 'org';
  tools: '' | 'with' | 'without';
  minRating: number;
  sort: 'relevance' | 'top' | 'imports' | 'new' | 'updated';
}

export interface SkillMarketPage {
  listings: SkillMarketListing[];
  hasMore: boolean;
  /** Set when the read failed or the user is signed out; the panel renders it. */
  error?: string;
}

export interface SkillMarketVersion {
  id: string;
  version: number;
  snapshot: ISkillSnapshot;
  honestSummary?: ISkillHonestSummary;
  riskTier?: SkillRiskTier;
  createdAt: string;
}

/** A newer approved version of a listing this user imported, worked out in main. */
export interface SkillMarketUpdate {
  /** The user's copy, which an update rewrites in place. */
  skillId: string;
  fromVersion?: number;
  toVersion: number;
  /** The version the diff was computed against; sent back so a newer one is refused, not applied. */
  versionId: string;
  diff: ChatDiff;
  toolsAdded: string[];
  toolsRemoved: string[];
  /** The user edited their copy since importing it; applying overwrites that. */
  locallyModified: boolean;
}

export interface SkillMarketDetail {
  listing: SkillMarketListing;
  version: SkillMarketVersion | null;
  myImport: { version: number; skill: { id: string; name: string } | null } | null;
  canImport: boolean;
  update?: SkillMarketUpdate;
}

export interface SkillMarketDetailResult {
  detail?: SkillMarketDetail;
  error?: string;
}

/** An unlisted listing is opened by its share token, with or without its id. */
export interface SkillMarketListingRef {
  id?: string;
  token?: string;
}

export interface SkillMarketImportRequest {
  listingId: string;
  token?: string;
  /** A different name for the copy, after a `name_taken` conflict. */
  name?: string;
  /** Update this existing copy in place instead of creating one. */
  targetSkillId?: string;
  /** Overwrite the user's local edits to that copy, after a `local_changes` conflict. */
  overwrite?: boolean;
  /** The version the user reviewed; a newer approval since then answers `version_changed`. */
  expectedVersionId?: string;
}

export type SkillMarketImportResult =
  | {
      ok: true;
      skill: { id: string; name: string };
      /** A local skill of the same name exists and runs instead of this import. */
      shadowedByLocal?: boolean;
    }
  | {
      ok: false;
      error: string;
      code?: 'name_taken' | 'local_changes' | 'version_changed';
      suggestedName?: string;
    };

/** An account skill that came from the market, for the Customize list's update badge. */
export interface SkillMarketImport {
  skillId: string;
  name: string;
  listingId: string;
  /** The server says a newer approved version exists. */
  updateAvailable: boolean;
}

export interface SkillMarketImportsResult {
  imports: SkillMarketImport[];
  error?: string;
}

/** What "Open on web" points at. Main builds the URL; the renderer never does. */
export type SkillMarketWebTarget = { kind: 'listing'; id: string } | { kind: 'skill'; id: string } | { kind: 'mine' };

/**
 * Publishing from desktop. Main reads the SKILL.md (a catalog entry or the native picker's pick,
 * never a path from the renderer), and every write runs only from an explicit click.
 */

/**
 * The account-skill fields an upload sends. Built field by field in main: no allowedTools. The
 * SKILL.md's allowed-tools travels as claudeCodeAllowedTools, kept for Claude Code exports only.
 */
export interface SkillUploadFields {
  name: string;
  description: string;
  body: string;
  argumentHint?: string;
  claudeCodeAllowedTools?: string[];
  disableModelInvocation?: boolean;
  /** A SKILL.md folder's scripts/ and references/ text files, sorted by path. */
  files?: ISkillFile[];
}

export type SkillUploadPreview =
  | {
      ok: true;
      fields: SkillUploadFields;
      /** Frontmatter keys Bike4Mind skills have no field for, such as model or hooks. */
      dropped: string[];
      /** Set when the file is a Bike4Mind export (it carries the source stamp). */
      source?: { url: string; thirdParty: boolean };
      /** Other files beside a SKILL.md, which are not uploaded (anything outside scripts/ and references/, and symlinks). The first few names, and the count. */
      extraFiles: string[];
      extraFileCount: number;
    }
  | { ok: false; error: string; canceled?: boolean };

/** A local skill as Customize lists it; main resolves it against its own catalog. */
export interface SkillLocalRef {
  sessionId: string | null;
  name: string;
}

export type SkillWriteCode = 'signed_out' | 'name_taken' | 'already_listed' | 'rate_limited' | 'exact_content';

export interface SkillSaveRequest {
  fields: SkillUploadFields;
  mode: 'create' | 'update';
  /** The existing own skill to overwrite, after the user chose "Update existing". */
  targetSkillId?: string;
  /** Resolves this session's project skills too when checking whether a local copy shadows the save. */
  sessionId?: string | null;
}

export type SkillSaveResult =
  | {
      ok: true;
      skill: { id: string; name: string };
      shadowedByLocal?: boolean;
      /** The updated skill already has an open listing, so the next step is a new version. */
      listing?: { id: string; name: string };
    }
  | {
      ok: false;
      error: string;
      code?: SkillWriteCode;
      /** On `name_taken`: the user's skill with that name. An imported one cannot be updated. */
      existing?: { id: string; imported: boolean };
    };

export interface SkillMarketOrg {
  id: string;
  name: string;
}

export interface SkillMarketOrgsResult {
  organizations: SkillMarketOrg[];
  error?: string;
}

export interface SkillPublishRequest {
  skillId: string;
  visibility: SkillListingVisibility;
  organizationId?: string;
  tags: string[];
}

export interface SkillSubmitVersionRequest {
  listingId: string;
  /** Written to the listing's source skill first. Absent when that skill was just saved. */
  fields?: SkillUploadFields;
}

/** A submitted version's scan and review state, for the result view. */
export interface SkillSubmittedVersion {
  version: number;
  scanStatus: string;
  reviewStatus: SkillReviewStatus | string;
  riskTier?: SkillRiskTier;
  reviewNote?: string;
  findings: { severity: string; message: string }[];
}

export type SkillSubmitResult =
  | { ok: true; listing: SkillMyListing; version: SkillSubmittedVersion }
  | {
      ok: false;
      error: string;
      code?: SkillWriteCode;
      /** On `already_listed`: the listing to submit a new version to instead. */
      listingId?: string;
      /** A new version's account-skill write landed though the submission did not. */
      skillUpdated?: boolean;
    };

/** A row of My listings. The share token stays in main; `hasShareLink` says whether one exists. */
export interface SkillMyListing {
  id: string;
  name: string;
  visibility: SkillListingVisibility;
  status: SkillListingStatus | string;
  hiddenByReports: boolean;
  tags: string[];
  currentVersion?: number;
  pendingVersion?: number;
  /** The newest version this client was sent, for its review note and risk tier. */
  latest?: { version: number; reviewStatus: string; riskTier?: SkillRiskTier; reviewNote?: string };
  delistedReason?: string;
  hasShareLink: boolean;
}

export interface SkillMyListingsResult {
  listings: SkillMyListing[];
  error?: string;
}

export type SkillActionResult = { ok: true } | { ok: false; error: string; code?: SkillWriteCode };
