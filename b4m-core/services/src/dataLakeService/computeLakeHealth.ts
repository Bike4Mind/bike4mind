import {
  DEFAULT_PASSAGE_TOKEN_TARGET,
  findDuplicateMembers,
  resolveLakeHealthPolicy,
  selectLakeHealthMembers,
  summarizeLakeHealth,
  type IAdminSettingsRepository,
  type IDataLakeDocument,
  type IFabFileRepository,
  type IScopedSettingsRepository,
  summarizeLakeMembership,
  effectiveTagPrefixArm,
  type DataLakeMembershipScope,
  type LakeHealthApiResponse,
  type LakeMembershipReport,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { lakeMembershipScope, registryMembershipScope } from './lakeMembershipScope';
import { isFallbackLake } from './assertLakeAccess';
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
 * How many duplicate-fileName groups, and how many members per group, the report carries. Both the
 * group count and each group's member count stay exact regardless. Bounded because neither dimension
 * of `groups` is capped by MEMBER_SCAN_LIMIT: a connector-synced lake full of generic names (`scan.pdf`,
 * `index.html`) can produce thousands of groups, and one giant group can hold every scanned member -
 * uncapped, either shape can push the response into multiple megabytes on a lake this endpoint (an
 * `isPublic` lake is reader-visible app-wide) can be asked to report on repeatedly.
 */
const DUPLICATE_GROUPS_RETURNED = 50;
const DUPLICATE_MEMBERS_PER_GROUP = 20;
/**
 * The same two bounds for the MEMBERSHIP dimension, which reports duplicates over its own (wider)
 * population - see the note on LakeHealthApiResponse.membership about the two overlapping. Prefixed
 * because the unprefixed names above belong to `duplicateMembers`; if that redundancy is resolved,
 * one of these two pairs goes with it.
 *
 * Groups are sorted worst-first before the cap (see summarizeLakeMembership), so a truncated list
 * holds the groups needing a human rather than an arbitrary slice.
 */
const MEMBERSHIP_GROUPS_RETURNED = 100;
/**
 * How many MEMBERS each of those groups carries. Capping groups alone left the payload bounded only
 * by MEMBER_SCAN_LIMIT, since one file name shared by N members is a single group holding N member
 * objects. Mirrors AFFECTED_MEMBERS_RETURNED, and like it every group keeps an exact `memberCount`
 * beside the capped array so no reader can be told there are fewer.
 */
const MEMBERSHIP_GROUP_MEMBERS_RETURNED = 200;

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
 *
 * Also reports duplicate members (#2239): a lake can pass all four predicates - every member
 * vectorized, chunk-consistent, vector-bearing, under the serve cap - while carrying two upload
 * generations of the same documents, which is measurably healthy and wrong. `findDuplicateMembers`
 * groups this same member scan by exact fileName; report-only, same as the rest of this module.
 * `groups` and each group's `members` are capped here for payload size (`DUPLICATE_GROUPS_RETURNED`,
 * `DUPLICATE_MEMBERS_PER_GROUP`); the counts stay exact regardless.
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

  // ONE scope for both reads and for the disclosure. A registry lake has no backing document, so its
  // `createdByUserId` is `''` (assertLakeAccess) and an `owned` scope would fail closed to
  // meta-tag-only - silently dropping the very arm those lakes are mostly made of, while the
  // disclosure still named a prefix. Branch here exactly as the sibling read paths do (see
  // GET /api/data-lakes/:id/articles), and never re-derive the disclosure from the lake document.
  const scope = isFallbackLake(lake) ? registryMembershipScope(lake) : lakeMembershipScope(lake);

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
      membership: summarizeLakeMembership([], { scope: membershipScopeDisclosure(scope) }),
      duplicateMembers: { memberCount: 0, groupCount: 0, groups: [] },
    };
  }

  // Independent reads over the same scope - membership deliberately admits a different population
  // (see computeMembership), and neither depends on the other's rows - so they run concurrently. Two
  // bounded aggregations overlap rather than queue, which is where the wall clock goes on a lake near
  // MEMBER_SCAN_LIMIT; the cost is that their peak connection and memory use now coincides.
  const [rows, membership] = await Promise.all([
    db.fabFiles.findDataLakeHealthMembers(scope, MEMBER_SCAN_LIMIT),
    computeMembership(scope, lake.id, db, logger),
  ]);
  const scanTruncated = rows.length > MEMBER_SCAN_LIMIT;
  const members = scanTruncated ? rows.slice(0, MEMBER_SCAN_LIMIT) : rows;
  if (scanTruncated) {
    logger?.warn?.(
      `[lakeHealth] lake ${lake.id} exceeds ${MEMBER_SCAN_LIMIT} members; health computed over the first ` +
        `${MEMBER_SCAN_LIMIT}. The reachable share is a partial figure - see scanTruncated.`
    );
  }

  const report = summarizeLakeHealth(members, policy);
  // Same admitted-members filter `summarizeLakeHealth` grades over, applied here explicitly rather
  // than relied on implicitly: the raw scan and the health report agree on membership by
  // construction, not because the DB `$match` happens to already filter it.
  const duplicates = findDuplicateMembers(selectLakeHealthMembers(members));
  return {
    ...report,
    affectedMembers: report.affectedMembers.slice(0, AFFECTED_MEMBERS_RETURNED),
    affectedMemberCount: report.affectedMembers.length,
    scanTruncated,
    membership,
    duplicateMembers: {
      memberCount: duplicates.memberCount,
      groupCount: duplicates.groupCount,
      groups: duplicates.groups.slice(0, DUPLICATE_GROUPS_RETURNED).map(g => ({
        ...g,
        members: g.members.slice(0, DUPLICATE_MEMBERS_PER_GROUP),
      })),
    },
  };
}

/**
 * The principal the prefix arm is anchored to, carried onto every membership number (#2243).
 *
 * Derived from the SCOPE that was queried, never from the lake document. `effectiveTagPrefixArm` is
 * the same decision `buildDataLakeMembershipFilter` builds its arm from, so the disclosure cannot
 * name an arm that did not run - which it did on every registry lake, and would again for any other
 * reason the filter drops a prefix (a reserved namespace, say).
 */
function membershipScopeDisclosure(scope: DataLakeMembershipScope): LakeMembershipReport['scope'] {
  return {
    // Empty string rather than null is how a registry lake's synthetic document spells "no creator",
    // so `??` was not enough: it shipped `''`, which matches neither documented state.
    creatorUserId: (scope.kind === 'owned' && scope.creatorUserId) || null,
    fileTagPrefix: effectiveTagPrefixArm(scope),
  };
}

/**
 * The membership dimension. A SECOND scan rather than a reuse of the health rows, because the two
 * admit different populations on purpose: health excludes chunkless members, membership must keep
 * them (see findDataLakeMembershipMembers).
 */
async function computeMembership(
  scope: DataLakeMembershipScope,
  lakeId: string,
  db: ComputeLakeHealthAdapters['db'],
  logger?: Logger
): Promise<LakeMembershipReport> {
  const rows = await db.fabFiles.findDataLakeMembershipMembers(scope, MEMBER_SCAN_LIMIT);
  const truncated = rows.length > MEMBER_SCAN_LIMIT;
  if (truncated) {
    logger?.warn?.(
      `[lakeHealth] lake ${lakeId} exceeds ${MEMBER_SCAN_LIMIT} members; membership computed over the ` +
        `OLDEST ${MEMBER_SCAN_LIMIT} (the scan is _id-ascending). Duplicate counts are a lower bound, ` +
        `and the members outside the window are the newest - see membership.scanTruncated.`
    );
  }
  return summarizeLakeMembership(truncated ? rows.slice(0, MEMBER_SCAN_LIMIT) : rows, {
    scope: membershipScopeDisclosure(scope),
    scanTruncated: truncated,
    maxGroups: MEMBERSHIP_GROUPS_RETURNED,
    maxGroupMembers: MEMBERSHIP_GROUP_MEMBERS_RETURNED,
  });
}
