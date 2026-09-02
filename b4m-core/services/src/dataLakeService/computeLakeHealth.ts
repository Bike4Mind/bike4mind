import {
  DEFAULT_PASSAGE_TOKEN_TARGET,
  findDuplicateMembers,
  resolveLakeHealthPolicy,
  summarizeLakeHealth,
  type IAdminSettingsRepository,
  type IDataLakeDocument,
  type IFabFileRepository,
  type IScopedSettingsRepository,
  type LakeHealthApiResponse,
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

export interface ComputeLakeHealthAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findDataLakeHealthMembers'>;
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
 *
 * Also reports duplicate members (#2239): a lake can pass all four predicates - every member
 * vectorized, chunk-consistent, vector-bearing, under the serve cap - while carrying two upload
 * generations of the same documents, which is measurably healthy and wrong. `findDuplicateMembers`
 * groups this same member scan by exact fileName; report-only, same as the rest of this module.
 */
export async function computeLakeHealth(
  lake: Pick<
    IDataLakeDocument,
    'id' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId' | 'organizationId' | 'requiredPassageTokenTarget'
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
      duplicateMembers: { memberCount: 0, groups: [] },
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
  const duplicateMembers = findDuplicateMembers(members);
  return {
    ...report,
    affectedMembers: report.affectedMembers.slice(0, AFFECTED_MEMBERS_RETURNED),
    affectedMemberCount: report.affectedMembers.length,
    scanTruncated,
    duplicateMembers,
  };
}
