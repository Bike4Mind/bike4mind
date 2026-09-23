import type {
  DataLakeStatus,
  IDataLakeAccessGrantDocument,
  IDataLakeAccessGrantRepository,
  IDataLakeRepository,
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

export interface ReportKeptPersonalLakeSharesAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findByIds'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByPrincipal' | 'listActiveByLakes'>;
  };
  logger?: LakeConfigAuditLogger;
}

/**
 * Read-only: what personal-lake shares does `departedUserId` currently hold, grouped by effective
 * owner. A lake the holder owns themselves is skipped - it is theirs, not a share they were given.
 *
 * Deliberately org-agnostic - it does not take an org to exclude. `!lake.organizationId` already
 * drops every org-owned lake, including the one just departed: this is meant to run AFTER an
 * org-departure transaction commits (personal-lake grants are untouched by it, so the result is the
 * same either way), decoupled from which org triggered the read.
 */
export async function reportKeptPersonalLakeShares(
  departedUserId: string,
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

  const byOwner = new Map<string, Array<{ id: string; name: string }>>();
  let lakeCount = 0;
  for (const lake of personal) {
    const owners = resolveEffectiveOwnerIds(lake, grantsByLake.get(lake.id) ?? []);
    if (owners.includes(departedUserId)) continue;
    lakeCount++;
    for (const ownerUserId of owners) {
      byOwner.set(ownerUserId, [...(byOwner.get(ownerUserId) ?? []), { id: lake.id, name: lake.name }]);
    }
  }
  return { lakeCount, byOwner: [...byOwner].map(([ownerUserId, lakes]) => ({ ownerUserId, lakes })) };
}
