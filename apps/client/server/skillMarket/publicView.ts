import type {
  ISkillListing,
  ISkillListingVersion,
  PublicSkillListing,
  PublicSkillListingVersion,
  SkillListingDetail,
} from '@bike4mind/common';
import type { ISkillListingDocument } from '@bike4mind/database';
import { serializeListing } from '@bike4mind/server-utils/skillMarket/market';
import type { buildListingDetail } from './detail';

/**
 * The /api/v1 Skill Market wire shape (schemas/skillMarketPublic.ts in @bike4mind/common): an
 * explicit snake_case allowlist. Built on `serializeListing`, so the privileged split (share token,
 * source skill, pending/latest version) is decided in one place for the SPA and v1 alike.
 */

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

export function toPublicListing(
  // An already-serialized row (search results, listing detail) re-serializes to itself.
  listing: ISkillListing | ISkillListingDocument | ReturnType<typeof serializeListing>,
  { privileged = false }: { privileged?: boolean } = {}
): PublicSkillListing {
  const l = serializeListing(listing as ISkillListing, { privileged }) as ReturnType<typeof serializeListing> &
    Partial<ISkillListing>;
  return {
    id: l.id,
    name: l.name,
    description: l.description,
    visibility: l.visibility,
    organization_id: l.organizationId ?? null,
    tags: l.tags ?? [],
    status: l.status,
    author_name: l.authorName ?? null,
    current_version: l.currentVersion ?? null,
    risk_tier: l.riskTier ?? null,
    uses_tools: Boolean(l.usesTools),
    auto_checked: Boolean(l.autoChecked),
    import_count: l.importCount ?? 0,
    rating_avg: l.ratingAvg,
    rating_count: l.ratingCount ?? 0,
    published_at: iso(l.publishedAt),
    created_at: iso(l.createdAt) ?? '',
    updated_at: iso(l.updatedAt) ?? '',
    ...(privileged
      ? {
          source_skill_id: l.sourceSkillId,
          share_token: l.shareToken,
          latest_version: l.latestVersion,
          pending_version: l.pendingVersion ?? null,
        }
      : {}),
  };
}

type VersionLike = Pick<ISkillListingVersion, 'id' | 'version' | 'snapshot' | 'createdAt'> &
  Partial<
    Pick<
      ISkillListingVersion,
      'riskTier' | 'honestSummary' | 'scanStatus' | 'scanFindings' | 'reviewStatus' | 'reviewNote'
    >
  >;

type SnapshotLike = VersionLike['snapshot'];

/**
 * A snapshot read without its body omits `body` and `files`. `withFiles: false` is for a snapshot read
 * with its body but not its files (the review queue's previous version, reviewQueue.ts).
 */
export function toPublicSnapshot(
  s: SnapshotLike,
  { withFiles = s.body !== undefined }: { withFiles?: boolean } = {}
): PublicSkillListingVersion['snapshot'] {
  return {
    name: s.name,
    description: s.description,
    ...(s.body !== undefined ? { body: s.body } : {}),
    argument_hint: s.argumentHint ?? null,
    allowed_tools: s.allowedTools ?? [],
    claude_code_allowed_tools: s.claudeCodeAllowedTools ?? [],
    disable_model_invocation: Boolean(s.disableModelInvocation),
    ...(withFiles ? { files: (s.files ?? []).map(({ path, content }) => ({ path, content })) } : {}),
  };
}

/** `privileged` (the author) adds the scan and review outcome. */
export function toPublicVersion(
  v: VersionLike,
  { privileged = false }: { privileged?: boolean } = {}
): PublicSkillListingVersion {
  const { snapshot: s, honestSummary: h } = v;
  return {
    id: String(v.id),
    version: v.version,
    snapshot: toPublicSnapshot(s),
    risk_tier: v.riskTier ?? null,
    honest_summary: h
      ? {
          what_it_does: h.whatItDoes,
          tools_used: h.toolsUsed ?? [],
          data_it_touches: h.dataItTouches,
          risk_notes: h.riskNotes ?? [],
          description_matches: h.descriptionMatches,
          mismatch_note: h.mismatchNote ?? null,
        }
      : null,
    created_at: iso(v.createdAt) ?? '',
    ...(privileged
      ? {
          scan_status: v.scanStatus,
          scan_findings: (v.scanFindings ?? []).map(f => ({
            rule: f.rule,
            severity: f.severity,
            message: f.message,
            excerpt: f.excerpt ?? null,
            source: f.source,
          })),
          review_status: v.reviewStatus,
          review_note: v.reviewNote ?? null,
        }
      : {}),
  };
}

/** `allowPrivileged: false` keeps author-only fields off even for the author (a read-only key). */
export function toPublicDetail(
  detail: Awaited<ReturnType<typeof buildListingDetail>>,
  { allowPrivileged = true }: { allowPrivileged?: boolean } = {}
): SkillListingDetail {
  const { listing, version, ratings, myImport, viewer } = detail;
  return {
    // Must stay in sync with the privileged flag in buildListingDetail (detail.ts).
    listing: toPublicListing(listing, { privileged: allowPrivileged && (viewer.isAuthor || viewer.canDelist) }),
    version: version ? toPublicVersion(version) : null,
    ratings: ratings.map(r => ({
      stars: r.stars ?? 0,
      review: r.review ?? null,
      rated_at: iso(r.ratedAt),
      mine: r.mine,
    })),
    my_import: myImport
      ? {
          version: myImport.version,
          stars: myImport.stars ?? null,
          review: myImport.review ?? null,
          skill: myImport.skill,
        }
      : null,
  };
}
