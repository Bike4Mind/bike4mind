import type { IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { lakeMembershipScope } from './lakeMembershipScope';
import { filterStillManagedLakes, type ManageRecheckAdapter } from './filterStillManagedLakes';
import type { ResolvedLakeAccess } from './getDynamicDataLakeTags';
import type { ResolvedLakeAccessSet } from './narrowLakeAccessToSession';

/**
 * `unionPreauthorizedLakeAccess`'s return shape, widened with which datalake tags this call
 * actually admitted (successfully revalidated against `filterStillManagedLakes`), as opposed to
 * `preauthorizedLakeIds` - the raw, unvetted session record.
 *
 * Exists because `excludedByAccessCount`/`measureIdentityNamedExclusion` (#3055) have no way to
 * tell a preauthorization-admitted lake apart from a genuinely gate-excluded one - both are
 * "reachable outside the normal gate" from their point of view, but only one was actually
 * searched this turn. A caller measuring exclusion against a specific session-named lake must
 * subtract THIS set from the identity tags it measures, or an admitted lake reports as excluded
 * even though the turn searched it. See `ChatCompletionProcess`'s promptMeta seed for the call
 * site this exists for.
 */
export type ResolvedLakeAccessSetWithAdmissions = ResolvedLakeAccessSet & {
  admittedPreauthorizedTags: Set<string>;
};

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
): Promise<ResolvedLakeAccessSetWithAdmissions> {
  // `excludedByAccessCount` (the ACCOUNT-WIDE number, #3055) rides through via `...access` in every
  // return below deliberately uncorrected: it is counted upstream from org-membership/public
  // visibility, and a manage-but-not-member preauthorized lake is (by definition of "not a member")
  // not a candidate for that count. `admittedPreauthorizedTags` is what lets the TARGETED,
  // session-scoped count (measureIdentityNamedExclusion) correct for the residual case - a
  // preauthorized lake that is ALSO public and gate-dropped - without recomputing the account-wide
  // number after every union. See this file's own `ResolvedLakeAccessSetWithAdmissions` doc.
  const noAdmissions = { admittedPreauthorizedTags: new Set<string>() };
  if (!preauthorizedLakeIds || preauthorizedLakeIds.length === 0 || !db.dataLakes) {
    return { ...access, ...noAdmissions };
  }
  const existingIds = new Set(access.lakes.map(l => l.id));
  const missingIds = preauthorizedLakeIds.filter(id => !existingIds.has(id));
  if (missingIds.length === 0) return { ...access, ...noAdmissions };

  const dataLakes = db.dataLakes;
  const fetched = await Promise.all(missingIds.map(id => dataLakes.findById(id)));
  const active = fetched.filter((lake): lake is IDataLakeDocument => !!lake && lake.status === 'active');
  const activeLakes = await filterStillManagedLakes(active, actorUserId, db);
  if (activeLakes.length === 0) return { ...access, ...noAdmissions };

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
    // Only the entries THIS call successfully revalidated - never the raw `preauthorizedLakeIds`
    // input, which may still name a lake `filterStillManagedLakes` just dropped above.
    admittedPreauthorizedTags: new Set(newEntries.map(e => e.datalakeTag)),
  };
}
