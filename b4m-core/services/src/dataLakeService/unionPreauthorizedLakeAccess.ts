import type { IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { lakeMembershipScope } from './lakeMembershipScope';
import type { ResolvedLakeAccess } from './getDynamicDataLakeTags';
import type { ResolvedLakeAccessSet } from './narrowLakeAccessToSession';

/**
 * Adds a session's pre-authorized lakes (manager-but-not-member admission) into an
 * already-resolved access set, as SCOPED (dynamic) entries - a pre-authorized lake is always a
 * DB lake, never a registry one. Authorization already happened once, at session-create time
 * (see pages/api/sessions/create.ts's canManageLake check); this trusts `preauthorizedLakeIds` as
 * already-vetted and only re-checks that the lake still exists and is still active, so a lake
 * deleted or archived after pre-authorization does not remain reachable.
 *
 * Call this BEFORE narrowLakeAccessToSession, not after: a "Test this lake" session's own
 * `retrievalTags` name the pre-authorized lake's tag, so the later subtractive narrow keeps
 * exactly the entry this union step adds.
 */
export async function unionPreauthorizedLakeAccess(
  access: ResolvedLakeAccessSet,
  preauthorizedLakeIds: string[] | undefined,
  db: { dataLakes?: Pick<IDataLakeRepository, 'findById'> }
): Promise<ResolvedLakeAccessSet> {
  if (!preauthorizedLakeIds || preauthorizedLakeIds.length === 0 || !db.dataLakes) return access;
  const existingIds = new Set(access.lakes.map(l => l.id));
  const missingIds = preauthorizedLakeIds.filter(id => !existingIds.has(id));
  if (missingIds.length === 0) return access;

  const dataLakes = db.dataLakes;
  const fetched = await Promise.all(missingIds.map(id => dataLakes.findById(id)));
  const activeLakes = fetched.filter((lake): lake is IDataLakeDocument => !!lake && lake.status === 'active');
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
