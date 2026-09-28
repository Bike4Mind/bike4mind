import type {
  DataLakeStatus,
  IDataLakeAccessGrantDocument,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
} from '@bike4mind/common';
import { resolveEffectiveOwnerIds } from './manageRule';
import type { LakeConfigAuditLogger } from './resolveLakeConfigAuditRetention';

/**
 * Shares on PERSONAL lakes (no `organizationId`) a departed member still holds. Deliberately not
 * lapsed by an org departure: the org never granted them, so leaving it ends nothing about them.
 * Reported so the lake owners can be told. `lakeCount` is the only part an org operator may see -
 * they cannot see these lakes, so names and ids must not reach them; `byOwner` is for the owner
 * email only.
 */
export interface KeptPersonalLakeShares {
  lakeCount: number;
  byOwner: Array<{ ownerUserId: string; lakes: Array<{ id: string; name: string }> }>;
}

const NO_KEPT_SHARES: KeptPersonalLakeShares = { lakeCount: 0, byOwner: [] };

// A lake on its way out reaches nobody, so a share on it is not worth an owner's attention.
const GOING_AWAY_STATUSES: readonly DataLakeStatus[] = ['deleting', 'deleted', 'purging'];

/**
 * Deliberately not `Pick<IDataLakeRepository, 'findByIds'>`: `IDataLakeRepository` is exported from
 * the published `@bike4mind/common` package, so a required member added there breaks every external
 * implementor. This report only ever needs one method, so it declares its own narrow port instead.
 */
export interface KeptPersonalLakeSharesDataLakes {
  /** Unusable ids are dropped rather than failing the whole `$in` - see `usableObjectIds`. */
  findByIds(ids: string[]): Promise<IDataLakeDocument[]>;
}

export interface ReportKeptPersonalLakeSharesAdapters {
  db: {
    dataLakes: KeptPersonalLakeSharesDataLakes;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByPrincipal' | 'listActiveByLakes'>;
  };
  logger?: LakeConfigAuditLogger;
}

/**
 * Read-only: what personal-lake shares does `departedUserId` currently hold, grouped by effective
 * owner. A lake the holder owns themselves is skipped - it is theirs, not a share they were given.
 *
 * Scoped to owners in `orgMemberUserIds`, the departed member's (former) org. A cross-tenant owner
 * has no relationship to that org and nothing to act on, so telling them the departed member's org
 * and exit date would only disclose a membership they were never meant to see. A lake owned entirely
 * outside the org is skipped: not counted, not emailed. The membership lookup itself belongs to the
 * caller - see `ReportKeptPersonalLakeSharesAdapters`, which takes no organization repository.
 */
export async function reportKeptPersonalLakeShares(
  departedUserId: string,
  orgMemberUserIds: readonly string[],
  adapters: ReportKeptPersonalLakeSharesAdapters,
  now: Date = new Date()
): Promise<KeptPersonalLakeShares> {
  const { db } = adapters;
  const held = await db.dataLakeAccessGrants.listByPrincipal('user', departedUserId, { activeAsOf: now });
  const lakeIds = [...new Set(held.map(grant => grant.dataLakeId))];
  if (lakeIds.length === 0) return NO_KEPT_SHARES;

  // findByIds drops an unusable id rather than CastError-ing the whole batch - see DataLakeModel.
  const personal = (await db.dataLakes.findByIds(lakeIds)).filter(
    lake => !lake.organizationId && !GOING_AWAY_STATUSES.includes(lake.status as DataLakeStatus)
  );
  if (personal.length === 0) return NO_KEPT_SHARES;

  const grants = await db.dataLakeAccessGrants.listActiveByLakes(
    personal.map(lake => lake.id),
    { activeAsOf: now }
  );
  const grantsByLake = new Map<string, IDataLakeAccessGrantDocument[]>();
  for (const grant of grants) {
    grantsByLake.set(grant.dataLakeId, [...(grantsByLake.get(grant.dataLakeId) ?? []), grant]);
  }

  const memberIds = new Set(orgMemberUserIds);
  const byOwner = new Map<string, Array<{ id: string; name: string }>>();
  let lakeCount = 0;
  for (const lake of personal) {
    const owners = resolveEffectiveOwnerIds(lake, grantsByLake.get(lake.id) ?? []);
    if (owners.includes(departedUserId)) continue;
    const inOrgOwners = owners.filter(ownerUserId => memberIds.has(ownerUserId));
    if (inOrgOwners.length === 0) continue;
    lakeCount++;
    for (const ownerUserId of inOrgOwners) {
      byOwner.set(ownerUserId, [...(byOwner.get(ownerUserId) ?? []), { id: lake.id, name: lake.name }]);
    }
  }
  return { lakeCount, byOwner: [...byOwner].map(([ownerUserId, lakes]) => ({ ownerUserId, lakes })) };
}
