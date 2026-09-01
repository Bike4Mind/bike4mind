import {
  DEFAULT_PASSAGE_TOKEN_TARGET,
  resolveLakeHealthPolicy,
  summarizeLakeHealth,
  type IAdminSettingsRepository,
  type IDataLakeDocument,
  type IFabFileRepository,
  type IScopedSettingsRepository,
  summarizeLakeMembership,
  type LakeHealthApiResponse,
  type LakeMembershipReport,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { lakeMembershipScope } from './lakeMembershipScope';
import { resolveScopedSetting, scopeForLake } from '../settings/resolveScopedSetting';

/**
 * How many members reach app memory. Health reads FabFile rows only (never chunks), and each row is a
 * handful of numbers, so this is generous; it exists so a pathological lake degrades LOUDLY (a logged,
 * flagged partial report) instead of trying to load unbounded rows. Real lakes are far below it.
 */
const MEMBER_SCAN_LIMIT = 25_000;
/** How many failing members the report carries for the drill-down. The count is always exact. */
const AFFECTED_MEMBERS_RETURNED = 200;
/**
 * How many duplicate GROUPS the report carries. The counts are always exact; this bounds the payload
 * only. Sorted worst-first before the cap (see summarizeLakeMembership), so a truncated list holds
 * the groups needing a human rather than an arbitrary slice.
 */
const DUPLICATE_GROUPS_RETURNED = 100;

export interface ComputeLakeHealthAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findDataLakeHealthMembers' | 'findDataLakeMembershipMembers'>;
    adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
    scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
  };
  logger?: Logger;
}

/**
 * Compute a lake's derived health (#1666): the four retrievability predicates and the reachable-content
 * headline, from the per-file rollups a lake's members carry - NEVER by scanning the chunk collection
 * (measured as ruinous at connector scale, #1665). Report-only and advisory: this decides nothing, it
 * only describes.
 *
 * The policy graded against is the lake's own (`explicit`, its `requiredPassageTokenTarget`) or the
 * `inherited` platform/owner `DefaultChunkSize` (epic decision 5), resolved through the SAME
 * `deriveServeCharBudget` the serve path uses, so predicate P4 ("serve cap >= policy size") cannot
 * disagree with what retrieval actually does.
 */
export async function computeLakeHealth(
  lake: Pick<
    IDataLakeDocument,
    | 'id'
    | 'datalakeTag'
    | 'fileTagPrefix'
    | 'createdByUserId'
    | 'organizationId'
    | 'requiredPassageTokenTarget'
    | 'inconsistencyReport'
    | 'inconsistencyComputedAt'
  >,
  { db, logger }: ComputeLakeHealthAdapters
): Promise<LakeHealthApiResponse> {
  const resolved = await resolveScopedSetting(
    'DefaultChunkSize',
    scopeForLake(lake),
    { adminSettings: db.adminSettings, scopedSettings: db.scopedSettings },
    { logger }
  );
  const inheritedTarget =
    typeof resolved.value === 'number' && Number.isFinite(resolved.value)
      ? resolved.value
      : DEFAULT_PASSAGE_TOKEN_TARGET;

  const policy = resolveLakeHealthPolicy({ explicitTarget: lake.requiredPassageTokenTarget, inheritedTarget });

  // Defense in depth: `datalakeTag` is `required: true` on the lake, but an absent one would serialize
  // to `null` in the membership `$match` and degrade the query to "files with no tags" across every
  // tenant - and this endpoint returns fileNames. Report an empty (well-formed) health instead of ever
  // scanning on a null tag. Mirrors the same guard in GET /api/data-lakes/:id/articles.
  if (!lake.datalakeTag) {
    const empty = summarizeLakeHealth([], policy);
    return {
      ...empty,
      affectedMembers: [],
      affectedMemberCount: 0,
      scanTruncated: false,
      membership: summarizeLakeMembership([], { scope: membershipScopeDisclosure(lake) }),
      inconsistency: storedInconsistency(lake),
    };
  }

  const rows = await db.fabFiles.findDataLakeHealthMembers(lakeMembershipScope(lake), MEMBER_SCAN_LIMIT);
  const scanTruncated = rows.length > MEMBER_SCAN_LIMIT;
  const members = scanTruncated ? rows.slice(0, MEMBER_SCAN_LIMIT) : rows;
  if (scanTruncated) {
    logger?.warn?.(
      `[lakeHealth] lake ${lake.id} exceeds ${MEMBER_SCAN_LIMIT} members; health computed over the first ` +
        `${MEMBER_SCAN_LIMIT}. The reachable share is a partial figure - see scanTruncated.`
    );
  }

  const report = summarizeLakeHealth(members, policy);
  return {
    ...report,
    affectedMembers: report.affectedMembers.slice(0, AFFECTED_MEMBERS_RETURNED),
    affectedMemberCount: report.affectedMembers.length,
    scanTruncated,
    membership: await computeMembership(lake, db, logger),
    // READ, never computed here: detection needs chunk text and this function may not touch the chunk
    // collection (#1665). detectLakeInconsistencies writes it; this renders whatever it last wrote.
    inconsistency: storedInconsistency(lake),
  };
}

/** Null means "never run", which a surface must not render as "clean". */
function storedInconsistency(
  lake: Pick<IDataLakeDocument, 'inconsistencyReport' | 'inconsistencyComputedAt'>
): LakeHealthApiResponse['inconsistency'] {
  return lake.inconsistencyReport
    ? { report: lake.inconsistencyReport, computedAt: lake.inconsistencyComputedAt ?? null }
    : null;
}

/** The principal the prefix arm is anchored to, carried onto every membership number (#2243). */
function membershipScopeDisclosure(
  lake: Pick<IDataLakeDocument, 'fileTagPrefix' | 'createdByUserId'>
): LakeMembershipReport['scope'] {
  return { creatorUserId: lake.createdByUserId ?? null, fileTagPrefix: lake.fileTagPrefix ?? null };
}

/**
 * The membership dimension. A SECOND scan rather than a reuse of the health rows, because the two
 * admit different populations on purpose: health excludes chunkless members, membership must keep
 * them (see findDataLakeMembershipMembers).
 */
async function computeMembership(
  lake: Parameters<typeof computeLakeHealth>[0],
  db: ComputeLakeHealthAdapters['db'],
  logger?: Logger
): Promise<LakeMembershipReport> {
  const rows = await db.fabFiles.findDataLakeMembershipMembers(lakeMembershipScope(lake), MEMBER_SCAN_LIMIT);
  const truncated = rows.length > MEMBER_SCAN_LIMIT;
  if (truncated) {
    logger?.warn?.(
      `[lakeHealth] lake ${lake.id} exceeds ${MEMBER_SCAN_LIMIT} members; membership computed over the ` +
        `first ${MEMBER_SCAN_LIMIT}. Duplicate counts are a lower bound - see membership.scanTruncated.`
    );
  }
  return summarizeLakeMembership(truncated ? rows.slice(0, MEMBER_SCAN_LIMIT) : rows, {
    scope: membershipScopeDisclosure(lake),
    scanTruncated: truncated,
    maxGroups: DUPLICATE_GROUPS_RETURNED,
  });
}
