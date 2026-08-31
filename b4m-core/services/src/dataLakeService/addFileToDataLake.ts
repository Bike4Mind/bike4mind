import type {
  IDataLakeAccessGrantRepository,
  IDataLakeRepository,
  IFabFileRepository,
  ILakeMembershipRemovalRepository,
  IAdminSettingsRepository,
  IScopedSettingsRepository,
} from '@bike4mind/common';
import { DATALAKE_TAG_PREFIX, normalizeTagPrefix, prefixArmTagNames } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { addFileToLake, type MembershipActor } from './lakeMembership';
import { assertLakeWritable } from './assertLakeAccess';
import { canManageLake, resolveEffectiveOwnerIds } from './manageRule';
import { loadActiveLakeGrants } from './authorizeLakeManage';
import { assertLakeAdmission, type AdmissionMember } from './lakeAdmissionGate';
import { createDataLakeFallbackTagger, UNCATEGORIZED_TAG_SUFFIX } from './fallbackLakeTags';
import { recomputeLakeStats } from './recomputeLakeStats';
import type { LakeConfigAuditAdapters } from './recordLakeConfigChange';

interface AddFileToDataLakeAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'findByDatalakeTag' | 'find' | 'setStats' | 'activateIfDraft'>;
    fabFiles: Pick<
      IFabFileRepository,
      'findById' | 'pushTagsByFabFileId' | 'pullTagsByFabFileId' | 'computeDataLakeStats'
    >;
    // REQUIRED, unlike `AddMembershipAdapters` (lakeMembership.ts) which leaves it optional for
    // high-fan-in file-creation paths. Optional here degrades to `[]` (loadActiveLakeGrants), so a
    // curator-granted manager would pass this door's own manage gate below and then be denied two
    // lines later inside `addFileToLake` - a 400-after-yes for the exact persona this issue is
    // about, which TS cannot catch (spread properties skip excess-property checks).
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    // The restore lookup (#2248 step 0.2) - REQUIRED, the same reasoning as
    // `removeFileFromDataLake`'s adapter: one caller, no blast radius, and an optional adapter
    // would make "restore silently falls to cold-add" a real (and silent) failure mode.
    lakeMembershipRemovals: Pick<ILakeMembershipRemovalRepository, 'findLive'>;
    // The admission contract's lever (#1680) resolves from these - required so this door cannot
    // quietly opt out of it, mirroring toggleTags' adapter (the gate itself reads nothing unless a
    // lake being joined declares a required passage size).
    adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
    scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
  };
}

/**
 * The names a restore may push back, re-validated against the LIVE lake config rather than
 * trusted verbatim from a stored record that could be stale:
 *  - keep only names `prefixArmTagNames` still recognizes under this lake's CURRENT
 *    `fileTagPrefix` (a lake whose prefix changed since the removal drops the entries that no
 *    longer match, rather than failing the restore - step 8's fallback tagger gives the file the
 *    current prefix's `uncategorized` node instead);
 *  - drop any name whose LOWERCASED form starts with the reserved `datalake:` namespace (folded
 *    case, unlike the prefix match above, because a `DataLake:x:` name is a storable prefix today
 *    and would otherwise mint membership in a DIFFERENT lake).
 *
 * `lakeMembershipSignals` already strips reserved-namespace names when it builds a record's
 * `contentTags` in the first place, so this should never actually trigger - but the push is the
 * wrong place to rely on that, since a record is stored data that can outlive the code that wrote
 * it.
 */
function validateRestoreContentTags(
  contentTags: readonly { name: string; strength: number }[],
  fileTagPrefix: string | undefined | null
): { name: string; strength: number }[] {
  const currentlyValidNames = new Set(
    prefixArmTagNames(
      contentTags.map(t => t.name),
      fileTagPrefix
    )
  );
  return contentTags.filter(
    t => currentlyValidNames.has(t.name) && !t.name.toLowerCase().startsWith(DATALAKE_TAG_PREFIX)
  );
}

/**
 * Add a file to a data lake - the mirror of `removeFileFromDataLake` (read that first). Unlike
 * the removal, this has TWO distinct reach guards, selected by the SERVER'S OWN record of a prior
 * removal rather than by anything the caller sends (see Key Decision 2 in the #2248 plan):
 *
 * - **Restore** (a live `LakeMembershipRemoval` exists for this lake+file): admits with NO
 *   ownership test, because the record IS the authorization - `removeFileFromLake` refuses a
 *   non-member, so a record can only exist for a file this lake demonstrably held minutes ago.
 *   Pushes back the record's real `contentTags` rather than a placeholder, and the admission
 *   contract grades report-only (a removal never un-chunks the file, so a restore cannot change
 *   whether it is retrievable).
 * - **Cold add** (no live record): admits only the lake's effective owner, the conservative
 *   shape for a genuinely new member, and the admission contract is enforced.
 *
 * The service takes NO restore payload from its caller at all - it looks the removal record up
 * itself. A caller that could choose the path could also choose which guards apply, which is
 * exactly what made an earlier revision of this door (a client-supplied tag list) both narrower
 * and wider than intended at once; see the plan's Key Decision 2 for the full history.
 */
export const addFileToDataLake = async (
  actor: MembershipActor,
  dataLakeId: string,
  fabFileId: string,
  { db, logger }: AddFileToDataLakeAdapters
): Promise<{ success: true; fileCount: number; totalSizeBytes: number }> => {
  const lake = await db.dataLakes.findById(dataLakeId);
  if (!lake) {
    throw new NotFoundError('Data lake not found');
  }

  // Loaded ONCE here so the cold-add ownership guard below and this manage decision agree on one
  // grant snapshot. The restore path needs no grant snapshot at all - its authorization is the
  // removal record, not `canManageLake`'s ownership rungs.
  const grants = await loadActiveLakeGrants(lake, { db });
  if (!canManageLake(lake, actor, grants)) {
    throw new BadRequestError('You do not have permission to add files to this data lake');
  }
  // Hoisted ahead of the file read so a non-manager gets the permission answer, never a probe of
  // whether a file id exists. `addFileToLake` re-checks manage rights internally; that redundancy
  // is deliberate - the shared membership write stays self-guarding.
  assertLakeWritable(lake);

  const file = await db.fabFiles.findById(fabFileId);
  // `BaseModel.findById` does not filter `deletedAt` (unlike the lake read-fallback), so this
  // guard is what stops the door re-stamping a lake meta-tag on a soft-deleted file.
  if (!file || file.deletedAt) {
    throw new NotFoundError('File not found');
  }

  const liveRemoval = await db.lakeMembershipRemovals.findLive(lake.id, fabFileId);
  const isRestore = !!liveRemoval;

  if (!isRestore) {
    // Cold-add path: admit only the lake's effective owner. Not-found-style denial, so the door
    // does not confirm the existence of a file the actor cannot see.
    const isOwner = file.userId === actor.userId || resolveEffectiveOwnerIds(lake, grants).includes(file.userId);
    if (!isOwner) {
      throw new NotFoundError('File not found');
    }
  }

  const member: AdmissionMember = {
    id: file.id,
    userId: file.userId,
    chunkedPassageTokenTarget: file.chunkedPassageTokenTarget,
  };
  // Cold add: enforce the retrievability contract on a genuinely new member. Restore: report-only
  // - grading it as a fresh join would measure something that did not change (the removal never
  // touched the file's chunks) and could permanently refuse a member ingested before the lake's
  // policy tightened, from a button labelled "Undo".
  await assertLakeAdmission([lake], [member], { db, logger, forceReportOnly: isRestore });

  // Idempotent (pushTagsByFabFileId), so a double-click or a retry converges.
  await addFileToLake(actor, lake, fabFileId, { db });

  if (isRestore && liveRemoval) {
    const validated = validateRestoreContentTags(liveRemoval.contentTags, lake.fileTagPrefix);
    if (validated.length > 0) {
      // `pushTagsByFabFileId` takes one strength per call, so group the restored tags by strength
      // (normally one or two calls) rather than assuming a uniform strength.
      const byStrength = new Map<number, string[]>();
      for (const tag of validated) {
        const names = byStrength.get(tag.strength) ?? [];
        names.push(tag.name);
        byStrength.set(tag.strength, names);
      }
      for (const [strength, names] of byStrength) {
        await db.fabFiles.pushTagsByFabFileId(fabFileId, names, strength);
      }
    }

    // Explicitly pull a stray `${prefix}uncategorized` left over from an earlier partial restore
    // attempt (8.1 failed, the fallback tagger below minted the placeholder, a retry then
    // succeeds) - the tagger's own retraction is keyed on DEPARTED lake meta-tags, and nothing
    // departs on a restore, so it cannot retract this on its own. Only when the restored set
    // carries a REAL tag under this prefix, and only when `uncategorized` was not itself among the
    // restored tags: a file can legitimately carry both, and an unconditional pull here would
    // delete the very placeholder section 0 promised to restore.
    const prefix = normalizeTagPrefix(lake.fileTagPrefix);
    if (prefix) {
      const uncategorizedName = `${prefix}${UNCATEGORIZED_TAG_SUFFIX}`;
      const hasRealTag = validated.some(t => t.name !== uncategorizedName);
      const hasCapturedUncategorized = validated.some(t => t.name === uncategorizedName);
      if (hasRealTag && !hasCapturedUncategorized) {
        await db.fabFiles.pullTagsByFabFileId(fabFileId, [uncategorizedName]);
      }
    }
  }

  // On BOTH paths: give a member with no content tag under this prefix (a cold add, or a restore
  // whose `contentTags` were empty) the `uncategorized` node, exactly as `toggleTags`'
  // `backfillLakeContentTags` does. Re-reads because the writes above are element-level atomic
  // ops with no returned document - the in-memory `file` is stale the moment any of them ran. That
  // re-read also makes steps 7-9's convergence explicit: three independent writes with no
  // compensation, each idempotent, so a retry converges rather than assuming it already did.
  const applyFallbackTags = createDataLakeFallbackTagger({ db, logger });
  const freshFile = await db.fabFiles.findById(fabFileId);
  const currentTags = freshFile?.tags ?? [];
  const reconciled = await applyFallbackTags(currentTags);
  const currentNames = new Set(currentTags.map(t => t.name));
  const reconciledNames = new Set(reconciled.map(t => t.name));
  const toAdd = reconciled.filter(t => !currentNames.has(t.name));
  const toRemove = [...currentNames].filter(name => !reconciledNames.has(name));
  if (toAdd.length > 0) {
    await db.fabFiles.pushTagsByFabFileId(
      fabFileId,
      toAdd.map(t => t.name),
      toAdd[0].strength
    );
  }
  if (toRemove.length > 0) {
    await db.fabFiles.pullTagsByFabFileId(fabFileId, toRemove);
  }

  // Left in place on success rather than consumed: a consumed record would make a partial failure
  // above unrecoverable, and re-running a restore is idempotent. It simply expires on its own TTL.

  const stats = await recomputeLakeStats(lake, { db, logger }, { actor });
  return { success: true, ...stats };
};
