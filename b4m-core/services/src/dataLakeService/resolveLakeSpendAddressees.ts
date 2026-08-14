import type { IDataLakeAccessGrantRepository, IDataLakeRepository, IOrganizationRepository } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { normalizeId } from '@bike4mind/utils';
import { resolveEffectiveOwnerIds, type LakeGrant } from './manageRule';

export interface LakeSpendAddressee {
  userId: string;
  email: string;
}

export interface LakeSpendAddresseeDb {
  dataLakes: Pick<IDataLakeRepository, 'findById'>;
  dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
  organizations: Pick<IOrganizationRepository, 'findById'>;
  users: { findActiveEmailsByIds(ids: string[]): Promise<Array<{ id: string; email: string }>> };
}

/** Bounds SMTP fan-out per notification - a pathological adminUserIds array must not turn one embedding call into a mail blast. */
export const MAX_LAKE_SPEND_ADDRESSEES = 20;

/**
 * Resolve who to notify about a data lake's spend (#1677). Never throws - a notification
 * failure must never break the ingestion path it would otherwise report on; any failure
 * resolves to `[]` and is logged.
 *
 * Org-owned lake: the org's billing owner (`userId`) + `managerId` + `adminUserIds` - the
 * SAME field set `administeredOrgIds` is built from (see OrganizationModel.findIdsWithAdminRights),
 * so the notified set agrees by construction with `canManageLake`'s org-admin rung - an
 * addressee is never mailed a link to a spend view they'd then be 403'd from. Also folds in
 * any org-principal owner/curator GRANT on this specific lake (canManageLake's org-grant
 * rung), a second, independent path to org-level management. If that combined set is empty
 * (org missing/soft-deleted, or none of those fields populated), falls through to the
 * individual-owner path below rather than returning nothing - a fallback recipient beats
 * silence.
 *
 * Individual/fallback path reuses the EXISTING `resolveEffectiveOwnerIds` (owner-role grant,
 * else the immutable creator) - not re-derived - with grants filtered to non-expired.
 *
 * Documented gap (out of scope, touches #1667's membership model itself): an org-principal
 * owner grant on an org-LESS lake resolves to the creator, not the org.
 */
export async function resolveLakeSpendAddressees(
  dataLakeId: string,
  db: LakeSpendAddresseeDb,
  logger?: Logger
): Promise<LakeSpendAddressee[]> {
  try {
    const lake = await db.dataLakes.findById(dataLakeId);
    if (!lake) return [];

    const activeGrants: LakeGrant[] = (
      await db.dataLakeAccessGrants.listByLake(dataLakeId, { activeAsOf: new Date() })
    ).map(g => ({ principalType: g.principalType, principalId: g.principalId, role: g.role }));

    let candidateIds: string[] = [];

    const lakeOrgId = normalizeId(lake.organizationId);
    if (lakeOrgId) {
      const org = await db.organizations.findById(lakeOrgId);
      const orgAdminIds = [org?.userId, org?.managerId, ...(org?.adminUserIds ?? [])].filter(
        (id): id is string => !!id && id.trim().length > 0
      );
      const orgGrantIds = activeGrants
        .filter(g => g.principalType === 'organization' && (g.role === 'owner' || g.role === 'curator'))
        .map(g => g.principalId);
      candidateIds = [...orgAdminIds, ...orgGrantIds];
    }

    if (candidateIds.length === 0) {
      // Either an individual lake, or an org lake whose admin set is empty/unresolvable -
      // fall back to the effective owner (owner-role user grant, else the creator).
      candidateIds = resolveEffectiveOwnerIds(lake, activeGrants);
    }

    const dedupedIds = Array.from(new Set(candidateIds)).sort();
    const boundedIds = dedupedIds.slice(0, MAX_LAKE_SPEND_ADDRESSEES);
    if (dedupedIds.length > boundedIds.length) {
      logger?.warn?.(
        `[resolveLakeSpendAddressees] truncated ${dedupedIds.length} candidates to ${boundedIds.length} for lake ${dataLakeId}`
      );
    }
    if (boundedIds.length === 0) return [];

    const rows = await db.users.findActiveEmailsByIds(boundedIds);
    const seenEmails = new Set<string>();
    const addressees: LakeSpendAddressee[] = [];
    for (const row of rows) {
      const email = row.email.trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (seenEmails.has(key)) continue;
      seenEmails.add(key);
      addressees.push({ userId: row.id, email });
    }
    return addressees;
  } catch (err) {
    logger?.warn?.(`[resolveLakeSpendAddressees] failed for lake ${dataLakeId}: ${err}`);
    return [];
  }
}
