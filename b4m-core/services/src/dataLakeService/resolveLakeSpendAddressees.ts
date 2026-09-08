import type {
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeRepository,
  IOrganizationRepository,
} from '@bike4mind/common';
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

/**
 * Bounds SMTP fan-out per notification - a pathological adminUserIds array must not turn one
 * embedding call into a mail blast. Bounds per lake, not across lakes: a `stopped`/`switch` (or
 * `/rate`) event has no platform-scope dedup claim, only the per-lake hourly key in
 * spendNotificationKeys.ts, so flipping the master switch off with a broad backlog can still
 * fan out lakes x up to this many emails within the hour. Accepted for now - narrowing it to a
 * single platform-wide claim is a real scope/design change (a new notification scope), not a
 * same-class fix to make alongside the copy corrections in this PR.
 */
export const MAX_LAKE_SPEND_ADDRESSEES = 20;

/** Bounds the ORG lookup fan-out itself (Promise.all over org.findById), separately from the
 * final MAX_LAKE_SPEND_ADDRESSEES cap on the resolved user list - a lake with many org-principal
 * grants would otherwise run an unbounded Promise.all inside the caller's send-timeout window. */
export const MAX_ORG_IDS_TO_RESOLVE = 20;

/**
 * Resolve who to notify about a data lake's spend. Never throws - a notification failure must
 * never break the ingestion path it would otherwise report on. Returns `null` (not `[]`) on
 * failure so the caller can distinguish "the lookup itself failed" from "the lookup succeeded
 * and genuinely found nobody" - conflating the two would let a transient DB blip permanently
 * suppress a lake's notifications, since the caller treats `[]` as a stable, keep-the-claim
 * outcome.
 *
 * Org-owned lake: the org's billing owner (`userId`) + `managerId` + `adminUserIds` - the
 * SAME field set `administeredOrgIds` is built from (see OrganizationModel.findIdsWithAdminRights)
 * - covers `canManageLake`'s org-admin rung. Also folds in any org-principal owner/curator GRANT
 * on this specific lake (canManageLake's org-grant rung) - each such grant's `principalId` is
 * itself an ORG id, resolved through the same org-admin-fields lookup, never pushed directly
 * into the user-id lookup (an org id can never match a user, which would otherwise silently
 * drop that source with no addressee and no error). This also covers an org-LESS lake carrying
 * an org-principal grant - the grant's own org is resolved regardless of `lake.organizationId`.
 *
 * The individual effective owner (`resolveEffectiveOwnerIds`: owner-role grant, else the
 * immutable creator) is always UNIONED in, not gated on the org set being empty - `canManageLake`'s
 * owner and org-admin rungs grant independently, so the notified set is a superset of the
 * org-admin rung (no false negatives), never a subset (a notified id unable to view the lake
 * was never possible either way).
 */
export async function resolveLakeSpendAddressees(
  dataLakeId: string,
  db: LakeSpendAddresseeDb,
  logger?: Logger,
  /** Pass the caller's already-fetched lake to skip a second findById; `undefined` (default)
   * still fetches it here, `null` short-circuits to [] the same as a lake that no longer exists. */
  prefetchedLake?: IDataLakeDocument | null
): Promise<LakeSpendAddressee[] | null> {
  try {
    const lake = prefetchedLake !== undefined ? prefetchedLake : await db.dataLakes.findById(dataLakeId);
    if (!lake) return [];

    const activeGrants: LakeGrant[] = (
      await db.dataLakeAccessGrants.listByLake(dataLakeId, { activeAsOf: new Date() })
    ).map(g => ({ principalType: g.principalType, principalId: g.principalId, role: g.role }));

    // Every org this lake's admin set could come from: the lake's own organizationId, plus
    // any org-principal owner/curator grant's principalId (which may be a different org, or
    // the same one - deduped below so it's resolved once either way).
    const orgIdsToResolve = new Set<string>();
    const lakeOrgId = normalizeId(lake.organizationId);
    if (lakeOrgId) orgIdsToResolve.add(lakeOrgId);
    for (const g of activeGrants) {
      if (g.principalType === 'organization' && (g.role === 'owner' || g.role === 'curator')) {
        orgIdsToResolve.add(g.principalId);
      }
    }

    let orgAdminIds: string[] = [];
    if (orgIdsToResolve.size > 0) {
      const boundedOrgIds = Array.from(orgIdsToResolve).slice(0, MAX_ORG_IDS_TO_RESOLVE);
      if (boundedOrgIds.length < orgIdsToResolve.size) {
        logger?.warn?.(
          `[resolveLakeSpendAddressees] truncated ${orgIdsToResolve.size} org ids to ${boundedOrgIds.length} for lake ${dataLakeId}`
        );
      }
      const orgs = await Promise.all(boundedOrgIds.map(id => db.organizations.findById(id)));
      orgAdminIds = orgs.flatMap(org =>
        [org?.userId, org?.managerId, ...(org?.adminUserIds ?? [])].filter(
          (id): id is string => !!id && id.trim().length > 0
        )
      );
    }

    // Always unioned, not gated on the org set being empty: canManageLake's owner rung and
    // org-admin rung grant independently, so an org lake's own owner must be notified too.
    // Effective owner FIRST: with a large org-admin set, the truncation below must never be
    // the thing that drops the one party who can actually act on the alert. Dedupe with a Set,
    // which preserves first-seen insertion order - no `.sort()`, which would re-scramble that
    // order back to arbitrary (id-string) priority.
    const candidateIds = [...resolveEffectiveOwnerIds(lake, activeGrants), ...orgAdminIds];

    const dedupedIds = Array.from(new Set(candidateIds));
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
    return null;
  }
}
