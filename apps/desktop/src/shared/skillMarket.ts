import type { ISkillHonestSummary, ISkillSnapshot, SkillListingVisibility, SkillRiskTier } from '@bike4mind/common';
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
