import type { IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { lakeMembershipScope } from './lakeMembershipScope';
import { filterStillManagedLakes, type ManageRecheckAdapter } from './filterStillManagedLakes';
import type { ResolvedLakeAccess } from './getDynamicDataLakeTags';
import type { ResolvedLakeAccessSet } from './narrowLakeAccessToSession';

/**
 * Adds a session's pre-authorized lakes (manager-but-not-member admission) into an
 * already-resolved access set, as SCOPED (dynamic) entries - a pre-authorized lake is always a
 * DB lake, never a registry one. Authorization happened first at session-create time (see
 * pages/api/sessions/create.ts's canManageLake check), and this RE-DERIVES it per turn against
 * the same rule, so the admission tracks the caller's current manage rights: a lake deleted,
 * archived, or whose curator grant / org-admin role was revoked stops being reachable from the
 * sessions already created for it. `preauthorizedLakeIds` is therefore a record of what was
 * admitted, never the authority for it.
 *
 * `actorUserId` is REQUIRED rather than optional so a new call site cannot skip the re-check by
 * omission - the widening is the whole point of this function, and an un-rechecked widening is
 * the vulnerability. It must be the principal the ids were vetted against
 * (vetPreauthorizedLakeIds, i.e. the session owner), not merely the turn's actor.
 *
 * Call this BEFORE narrowLakeAccessToSession, not after: a "Test this lake" session's own
 * `retrievalTags` name the pre-authorized lake's tag, so the later subtractive narrow keeps
 * exactly the entry this union step adds.
 */
export async function unionPreauthorizedLakeAccess(
  access: ResolvedLakeAccessSet,
  preauthorizedLakeIds: string[] | undefined,
  actorUserId: string,
  db: { dataLakes?: Pick<IDataLakeRepository, 'findById'> } & ManageRecheckAdapter
): Promise<ResolvedLakeAccessSet> {
  if (!preauthorizedLakeIds || preauthorizedLakeIds.length === 0 || !db.dataLakes) return access;
  const existingIds = new Set(access.lakes.map(l => l.id));
  const missingIds = preauthorizedLakeIds.filter(id => !existingIds.has(id));
  if (missingIds.length === 0) return access;

  const dataLakes = db.dataLakes;
  const fetched = await Promise.all(missingIds.map(id => dataLakes.findById(id)));
  const active = fetched.filter((lake): lake is IDataLakeDocument => !!lake && lake.status === 'active');
  const activeLakes = await filterStillManagedLakes(active, actorUserId, db);
  if (activeLakes.length === 0) return access;

  const newEntries: ResolvedLakeAccess[] = activeLakes.map(lake => ({
    id: lake.id,
    name: lake.name,
    slug: lake.slug,
    datalakeTag: lake.datalakeTag,
    fileTagPrefix: lake.fileTagPrefix,
    membership: lakeMembershipScope(lake),
    source: 'dynamic',
  }));
  const dataLakeTags = new Set(access.dataLakeTags);
  const scopedTagPrefixes = new Set(access.scopedTagPrefixes);
  for (const entry of newEntries) {
    dataLakeTags.add(entry.datalakeTag);
    scopedTagPrefixes.add(entry.fileTagPrefix);
  }
  return {
    ...access,
    dataLakeTags: Array.from(dataLakeTags),
    scopedTagPrefixes: Array.from(scopedTagPrefixes),
    lakes: [...access.lakes, ...newEntries],
  };
}
