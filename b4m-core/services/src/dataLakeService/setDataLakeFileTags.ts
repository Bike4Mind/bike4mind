import type {
  IAdminSettingsRepository,
  IDataLakeAccessGrantRepository,
  IDataLakeRepository,
  IFabFileRepository,
  IScopedSettingsRepository,
} from '@bike4mind/common';
import { DATALAKE_TAG_PREFIX, MAX_LAKE_FILE_TAG_NAME_LENGTH, prefixArmTagNames } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { assertLakeWritable } from './assertLakeAccess';
import { assertCanWriteStaticRegistryTags } from './authorizeLakeWrite';
import { canManageLake } from './manageRule';
import { loadActiveLakeGrants, makeLakeGrantResolver } from './authorizeLakeManage';
import {
  lakeMembershipSignals,
  satisfiesMembershipScope,
  type MembershipActor,
  type MembershipLake,
} from './lakeMembership';
import { lakeMembershipScope } from './lakeMembershipScope';
import {
  decideStampPrefix,
  createDataLakeFallbackTagger,
  UNCATEGORIZED_TAG_SUFFIX,
  LAKE_CONTENT_TAG_STRENGTH,
} from './fallbackLakeTags';
import { findPrefixArmChanges } from './prefixArmMembership';
import { assertLakeAdmission, type AdmissionMember } from './lakeAdmissionGate';
import { recomputeLakeStats } from './recomputeLakeStats';
import type { LakeConfigAuditAdapters } from './recordLakeConfigChange';

interface SetDataLakeFileTagsAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    // `findByDatalakeTag` is for the fallback tagger's own lake resolution (step 15), not for
    // anything this door resolves directly - the tagger takes the whole `db` bag.
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'findByDatalakeTag' | 'find' | 'setStats' | 'activateIfDraft'>;
    fabFiles: Pick<
      IFabFileRepository,
      'findById' | 'pushTagsByFabFileId' | 'pullTagsByFabFileId' | 'computeDataLakeStats'
    >;
    // REQUIRED, unlike the removal door which leaves it optional: `loadActiveLakeGrants` degrades
    // to `[]` when unwired (authorizeLakeManage.ts), and the curator/org-grant persona IS this
    // issue's AC. TS cannot catch an omission here - the route spreads `...lakeConfigAuditDb`, and
    // spread properties skip excess-property checks. `listActiveByLakes` is needed too, for the
    // batched grant resolver that gates step 11's third-lake stats recompute.
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake' | 'listActiveByLakes'>;
    // No `lakeMembershipRemovals`: this door neither reads nor writes a removal record - see the
    // door's own docblock for why a removal record would defeat the point of this fix.
    //
    // The admission contract's lever (#1680) resolves from these. REQUIRED, matching both
    // siblings: the gate itself reads nothing unless a lake being JOINED (step 11) declares a
    // required passage size, but a door that could opt out of it silently would undermine the
    // contract everywhere else it is enforced. `adminSettings` doubles as the audit-retention
    // lever through `LakeConfigAuditAdapters` (there it is optional - "absent simply means the
    // retention lever is not read here"); the admission gate is what makes it genuinely required
    // on THIS door.
    adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
    scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
  };
  /** Forwarded to the fallback tagger's and admission gate's skip-path diagnostics. */
  logger?: { warn?: (msg: string, ...args: unknown[]) => void; log?: (msg: string, ...args: unknown[]) => void };
}

export interface SetDataLakeFileTagsResult {
  success: true;
  fileCount: number;
  totalSizeBytes: number;
  tags: {
    /** Pushed by this call. */
    added: string[];
    /** Pulled by this call - includes the swept `<prefix>uncategorized` placeholder, if any. */
    removed: string[];
    /**
     * Under the prefix, not in the caller's desired set, but outside this lake's removal reach
     * (a non-creator-owned file's stale name, or an existing name over the length cap) -
     * DECLINED, not forgotten. The only way a caller learns a declarative PUT under-delivered.
     */
    retained: string[];
    /** POST-WRITE truth, from the re-read after every write below has landed. */
    current: string[];
  };
}

/**
 * All refusals here are `BadRequestError` and reject the WHOLE request, naming exactly ONE
 * offender - never the caller's whole array, in the error or in a log.
 */
const validateRequestedTags = (requestedTags: readonly string[], prefix: string): string[] => {
  const desired: string[] = [];
  const seen = new Set<string>();
  for (const name of requestedTags) {
    // Case-folded, unlike the prefix match below: `DataLake:x:` is a storable prefix today, and
    // a name under it would mint membership in a DIFFERENT lake (addFileToDataLake.ts:52-54).
    if (name.toLowerCase().startsWith(DATALAKE_TAG_PREFIX)) {
      throw new BadRequestError(
        `"${name}" is in the reserved "${DATALAKE_TAG_PREFIX}" namespace and cannot be set here`
      );
    }
    // Case-SENSITIVE, matching `prefixArmTagNames`. Deliberately rejects rather than filters (the
    // opposite of `validateRestoreContentTags`): under replace semantics the submitted set IS the
    // end state, so a mis-cased prefix that silently dropped every name would deliver exactly the
    // de-categorization this issue is about.
    if (!name.startsWith(prefix)) {
      throw new BadRequestError(`"${name}" is not under this lake's tag prefix "${prefix}"`);
    }
    if (name === prefix) {
      throw new BadRequestError(`"${name}" has no name after the prefix "${prefix}"`);
    }
    if (name !== name.trim()) {
      throw new BadRequestError(`"${name}" has leading or trailing whitespace`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      desired.push(name);
    }
  }
  return desired;
};

/**
 * Set a file's content tags UNDER ONE LAKE'S PREFIX to exactly the caller's desired set -
 * scoped-replace semantics: the body is the complete desired set under this lake's
 * `fileTagPrefix`, and this diffs it against the file's stored tags and pushes/pulls to match.
 * Tags outside the prefix are untouched.
 *
 * Closes the authority asymmetry #2255 is about: `removeFileFromDataLake` lets a lake MANAGER
 * (curator grant, org admin, platform admin - not necessarily the file's owner) pull every tag
 * under the lake's prefix, but the only tag-write door (`toggleTags`) is gated by
 * `findAllAccessibleByIds` and admits only the file's owner or a share. A manager could erase a
 * member's whole in-lake categorization and could not put a single tag back. This composes the
 * same body as `fabFileService/reconcileLakeTags.ts` - `canManageLake` + `assertLakeWritable` +
 * `assertCanWriteStaticRegistryTags` + a prefix-bounded diff over a caller-authored REPLACE set +
 * the fallback tagger + `findPrefixArmChanges` + `recomputeLakeStats` - but sits behind the LAKE's
 * gate rather than the file's ACL (the gap this issue closes), and REFUSES rather than evicts a
 * write that would end membership (`reconcileLakeTags` instead force-carries a leaving lake's
 * last signal tag back in, which would contradict this door's declared replace semantics). Must
 * stay in sync with `reconcileLakeTags` and `toggleTags` (see the "must stay in sync" note on
 * `toggleTags.ts`) - all three answer "what tags does this file carry under a lake's prefix" and
 * must not drift apart.
 *
 * The ADD and REMOVE halves have different reach, and the difference is load-bearing
 * (`lakeMembership.ts`'s `ownsFile` conjunct): `add` accepts any name passing `prefixArmTagNames`
 * under this lake's prefix (the fallback tagger already stamps a stranger-owned meta-tag
 * member's file this way with no ownership test), but `remove` reaches ONLY
 * `lakeMembershipSignals(lake, file).contentTags` - which is `[]` for a file the lake's creator
 * does not own - PLUS the one server-chosen `<prefix>uncategorized` placeholder (`sweptPlaceholder`
 * in the diff below), never the unconditional `prefixArmTagNames`. Widening `removable` to
 * `prefixArmTagNames` would let a manager strip a stranger's own tags off their file, the exact
 * hazard `removeFileFromDataLake.ts` guards against. `retained` in the response is what reports a
 * name this door declined to touch.
 *
 * No new audit action (`LAKE_CONFIG_CHANGE_ACTIONS` has no membership action, and neither sibling
 * door writes a `LakeConfigChangeEvent`) - the step-17 log line is the only trail. It is
 * retrievable (`minLevel: 'info'` by default) but nothing alarms on it; this is a deliberate
 * choice, not an oversight - see the plan this door was built from.
 *
 * Concurrency: last-writer-partially-wins, deliberately. The writes below are element-level
 * atomic ops (`pushTagsByFabFileId`/`pullTagsByFabFileId`), not a whole-array rewrite guarded by
 * optimistic concurrency - a whole-array rewrite is exactly the failure `toggleTags` and
 * `removeFileFromLake` avoid, because a slow writer's snapshot can resurrect a tag a concurrent
 * removal from a DIFFERENT lake just pulled. `current` in the response (from the step-15 re-read)
 * is the authoritative answer, not the computed intent. The push itself is not atomic across
 * names either - `pushTagsByFabFileId` is a per-name ordered `bulkWrite`, so a mid-batch failure
 * leaves a partial push; the all-or-nothing property below is about the REFUSALS, not the writes.
 *
 * There is no undo for a bad PUT: this door stores no prior state (unlike the removal door's
 * `LakeMembershipRemoval`), so reconstructing a previous tag set means reading the step-17 log.
 */
export const setDataLakeFileTags = async (
  actor: MembershipActor,
  dataLakeId: string,
  fabFileId: string,
  requestedTags: readonly string[],
  { db, logger }: SetDataLakeFileTagsAdapters
): Promise<SetDataLakeFileTagsResult> => {
  // Step 1
  const lake = await db.dataLakes.findById(dataLakeId);
  if (!lake) {
    throw new NotFoundError('Data lake not found');
  }

  // Steps 2-3. Hoisted ahead of the file read (step 6) so a non-manager gets the permission
  // answer, never a probe of whether a file id exists (same as `addFileToDataLake.ts:113-115`).
  const grants = await loadActiveLakeGrants(lake, { db });
  if (!canManageLake(lake, actor, grants)) {
    throw new BadRequestError("You do not have permission to change this data lake's files");
  }

  // Step 4. A fallback lake has no document to hold tags.
  assertLakeWritable(lake);

  // Step 5. An unusable/reserved/colliding prefix is a property of the LAKE, refused once here
  // rather than once per submitted tag, and before any file read. `decideStampPrefix` is the ONE
  // gate on "may this lake mint a content tag, and under what prefix" - shared with the write-
  // door reconciler and the backfill migration so all three cannot decide differently. Unlike
  // those two, this door FAILS CLOSED on `overlapCheckFailed` too: it admits CALLER-AUTHORED
  // names across an unverified overlap, not a fixed placeholder, so a failed diagnostic must not
  // let a curator mint prefix-arm membership in a lake they may hold no rights over.
  const decision = await decideStampPrefix(lake, { dataLakes: db.dataLakes, logger });
  if (!decision.stamp) {
    throw new BadRequestError(
      decision.detail
        ? `This lake's tag prefix cannot be used right now: ${decision.reason} (${decision.detail})`
        : `This lake's tag prefix cannot be used right now: ${decision.reason}`
    );
  }
  if (decision.overlapCheckFailed) {
    throw new BadRequestError(
      "Could not verify this lake's tag prefix does not overlap another lake right now - try again"
    );
  }
  const prefix = decision.prefix;

  // Step 6. `BaseModel.findById` does not filter `deletedAt`, unlike the lake read-fallback -
  // this guard is what stops the door writing tags onto a soft-deleted file. Both this and the
  // step-7 refusal below return the SAME message, matching `removeFileFromLake`'s collapse of
  // `!file || !inLake` into one string: two different strings would tell a lake manager that a
  // given ObjectId names a live FabFile.
  const file = await db.fabFiles.findById(fabFileId);
  if (!file || file.deletedAt) {
    throw new NotFoundError('File not found in this data lake');
  }

  // Step 7. THE SINGLE MOST IMPORTANT GATE in this design. Without it a curator of this lake
  // could PUT a tag under its prefix against ANY creator-owned file in the install and mint
  // prefix-arm membership - and membership is read access, since the meta-tag arm of
  // `buildDataLakeMembershipFilter` carries no ownership conjunct. LOAD-BEARING for the same
  // reason `lakeMembership.ts`'s own comment states for `removeFileFromLake`'s identical
  // refusal: every path that establishes a `datalake:` meta-tag or a prefix-arm signal is gated
  // by the file's owner, the lake owner's own library, or an upload the caller is performing -
  // there is no bootstrap.
  const signals = lakeMembershipSignals(lake, file);
  if (!signals.inLake) {
    throw new NotFoundError('File not found in this data lake');
  }

  // Step 8. Reject-not-filter validation (section 4).
  const desired = validateRequestedTags(requestedTags, prefix);

  // Step 9. Pure backstop on the NAMES, pairing step 5's backstop on the lake's PREFIX.
  assertCanWriteStaticRegistryTags(actor, desired);

  // Step 10: the diff. See the module docblock for why add and remove have different reach.
  const fileTagNames = (file.tags ?? []).map(t => t?.name).filter((name): name is string => typeof name === 'string');
  // `prefixArmTagNames` already excludes a reserved-namespace prefix's own arm, but a stray
  // `datalake:*` name could in principle still start with a non-reserved prefix string - excluded
  // here defensively, mirroring `lakeMembershipSignals`' own `contentTagNames` filter.
  const currentUnderPrefix = prefixArmTagNames(fileTagNames, prefix).filter(
    name => !name.startsWith(DATALAKE_TAG_PREFIX)
  );
  const currentUnderPrefixSet = new Set(currentUnderPrefix);
  // An existing name over the cap cannot have been submitted (the schema bounds every submitted
  // name's length), so it can never appear in `desired` - it always lands in `retained` below
  // rather than being silently pulled. See MAX_LAKE_FILE_TAG_NAME_LENGTH's own doc for why this
  // population is real (the upload path's folder-derived names are not truncated).
  const overCap = new Set(currentUnderPrefix.filter(name => name.length > MAX_LAKE_FILE_TAG_NAME_LENGTH));
  // This lake's own removal reach - see `lakeMembershipSignals`' `ownsFile` conjunct. Empty for a
  // file the lake's creator does not own.
  const removable = new Set(signals.contentTags.map(t => t.name).filter(name => !overCap.has(name)));

  const desiredSet = new Set(desired);
  const placeholder = `${prefix}${UNCATEGORIZED_TAG_SUFFIX}`;
  // The one name whose removal is NOT bounded by `removable` - server-chosen, never
  // caller-authored, which is the whole reason it does not breach the no-reach-into-a-stranger's-
  // namespace property. Deciding this HERE, inside the diff, is what makes `resultingTagNames`
  // (below, feeding step 11) and `removed`/`retained` (the response) describe the REAL post-state
  // instead of a step-10 diff plus an invisible extra pull. See the module docblock's remove-half
  // paragraph and `fallbackLakeTags.ts`'s mint-blind stamp for why the door needs this at all.
  const sweptPlaceholder: string[] =
    fileTagNames.includes(placeholder) && desired.some(name => name !== placeholder) && !desiredSet.has(placeholder)
      ? [placeholder]
      : [];

  const toAdd = desired.filter(name => !currentUnderPrefixSet.has(name));
  // UNION, not concatenation: the placeholder can already qualify via `removable` (a creator-owned
  // member's own reach includes it), so a plain concat would duplicate it here and in the
  // persisted `pullTagsByFabFileId` call / the response's `removed` array.
  const toRemoveSet = new Set([
    ...currentUnderPrefix.filter(name => !desiredSet.has(name) && removable.has(name)),
    ...sweptPlaceholder,
  ]);
  const toRemove = [...toRemoveSet];
  // DECLINED, not forgotten: under the prefix, not in `desired`, but outside this lake's removal
  // reach on this file. Includes any over-cap existing name, since such a name can never be in
  // `desired` and is never in `removable`.
  const retained = currentUnderPrefix.filter(name => !desiredSet.has(name) && !toRemoveSet.has(name));

  // Feeds step 11. Deciding the sweep INSIDE the diff (above) rather than as a post-write step is
  // what makes this the real post-state.
  const resultingTagNames = [...fileTagNames.filter(name => !toRemoveSet.has(name)), ...toAdd];

  // Step 11. `findPrefixArmChanges` is anchored on the FILE'S OWNER, which is not known until the
  // file is read at step 6 - this cannot move earlier. Pass no `candidateLakes`:
  // `resolveCandidates` resolves them itself for a single-file caller and short-circuits to zero
  // queries when nothing changed could carry a prefix arm; pre-resolving would forfeit that.
  // THIS lake stays out of `joins`/`leaves` by consequence (a meta-tag member is skipped by the
  // `datalakeTag` guard inside `findPrefixArmChanges`; a prefix-only member is guaranteed a
  // non-empty resulting signal by step 12's refusal below), not by construction -
  // `findPrefixArmChanges` takes no `excludeLake` the way the sibling `resolveOtherLakeClaims`
  // does.
  const { leaves, joins } = await findPrefixArmChanges(
    { fileOwnerUserId: file.userId, currentTagNames: fileTagNames, resultingTagNames },
    { db }
  );
  const member: AdmissionMember = {
    id: file.id,
    userId: file.userId,
    chunkedPassageTokenTarget: file.chunkedPassageTokenTarget,
  };
  if (joins.length > 0) {
    // The admission contract runs on JOINS only, over EVERY lake this write joins by prefix arm -
    // managed and unmanaged alike, same as `reconcileLakeTags`/`toggleTags`. Under step 12's
    // precondition THIS lake's own membership cannot flip, so there is nothing to admit for the
    // URL lake - but a prefix-arm join into a co-prefixed THIRD lake is real membership this door
    // would otherwise create ungraded.
    await assertLakeAdmission(
      joins.map(j => j.lake),
      [member],
      { db, logger }
    );
  }

  // Step 12. Refuse rather than evict - the post-state predicate, not "is the body empty": a
  // creator-owned, prefix-only member whose desired set goes empty would otherwise have its LAST
  // signal pulled, a silent removal through a door that writes no `LakeMembershipRemoval`.
  // `satisfiesMembershipScope` is the right predicate (not `lakeMembershipSignals`): the question
  // here is a pure boolean over a HYPOTHETICAL tag array, and it is the mirror pinned against real
  // Mongo by a parity e2e test. Tag OBJECTS, not names: surviving tags keep their stored strength,
  // additions carry `LAKE_CONTENT_TAG_STRENGTH`.
  const survivingTags = (file.tags ?? []).filter(t => typeof t?.name === 'string' && !toRemoveSet.has(t.name));
  const resulting = [...survivingTags, ...toAdd.map(name => ({ name, strength: LAKE_CONTENT_TAG_STRENGTH }))];
  if (!satisfiesMembershipScope(lakeMembershipScope(lake), { userId: file.userId, tags: resulting })) {
    throw new BadRequestError(
      `This change would remove the file from "${lake.name}", which this endpoint cannot do. ` +
        `Keep at least one tag under "${prefix}" (for example "${prefix}${UNCATEGORIZED_TAG_SUFFIX}"), ` +
        `or use DELETE /api/data-lakes/:id/files/:fabFileId.`
    );
  }

  // Computed off the step-6 snapshot, against the WHOLE `toRemove` set (including
  // `sweptPlaceholder`): `pullTagsByFabFileId` `$unset`s a matching `primaryTag` on EVERY pull, so
  // a flag computed only against caller-asked-for removals would report `false` for a clearing
  // that really happened.
  const primaryTagCleared = typeof file.primaryTag === 'string' && toRemoveSet.has(file.primaryTag);

  // No compensation past this point - steps 11 and 12 are why everything above ran first.

  // Step 13. PUSH BEFORE PULL (step 14): `removeFileFromLake` uses one atomic $pull precisely so
  // there is no window where the meta-tag is gone but a prefixed tag still matches; add and
  // remove are different Mongo ops here, so choose the ordering whose crash state is safe.
  // Push-then-crash leaves the file over-tagged and still a member; pull-then-crash could evict a
  // prefix-only member with nothing recorded. Both writes are idempotent, so a retry converges.
  if (toAdd.length > 0) {
    await db.fabFiles.pushTagsByFabFileId(fabFileId, toAdd, LAKE_CONTENT_TAG_STRENGTH);
  }

  // Step 14.
  if (toRemove.length > 0) {
    await db.fabFiles.pullTagsByFabFileId(fabFileId, toRemove);
  }

  // Step 15. Re-read: steps 13-14 are element-level atomic ops with no returned document. ADDITIVE
  // ONLY (no `previousTags`) - this door's own write above can only ever leave a MEMBER of this
  // lake (step 12), so nothing here should ever retract this lake's own stamp; the tagger's
  // purpose on this path is the safety net for a meta-tag member whose desired set was empty.
  const applyFallbackTags = createDataLakeFallbackTagger({ db, logger });
  const freshFile = await db.fabFiles.findById(fabFileId);
  const currentTags = freshFile?.tags ?? [];
  const reconciled = await applyFallbackTags(currentTags);
  const currentNames = new Set(currentTags.map(t => t.name));
  const fallbackAdditions = reconciled.filter(t => !currentNames.has(t.name));
  if (fallbackAdditions.length > 0) {
    await db.fabFiles.pushTagsByFabFileId(
      fabFileId,
      fallbackAdditions.map(t => t.name),
      fallbackAdditions[0].strength
    );
  }

  // Step 16. This lake, no `skipActivation`: this actor is a proven manager (step 3), the same
  // condition `toggleTags.ts` uses to run the unsuppressed recompute.
  const stats = await recomputeLakeStats(lake, { db, logger }, { actor });

  // Every OTHER lake in `joins`/`leaves`: `skipActivation` unless this actor manages THAT lake -
  // exactly the split `toggleTags.ts` makes for its own prefix-arm joins. Resolved through the
  // same batched grant resolver the sibling doors use; not step 2's grants, which belong to the
  // URL lake.
  const otherLakes = new Map<string, MembershipLake>();
  for (const { lake: otherLake } of [...joins, ...leaves]) otherLakes.set(otherLake.id, otherLake);
  if (otherLakes.size > 0) {
    const grantResolver = makeLakeGrantResolver({ db });
    await grantResolver.prime([...otherLakes.values()]);
    for (const otherLake of otherLakes.values()) {
      const manages = canManageLake(otherLake, actor, grantResolver.get(otherLake.id));
      await recomputeLakeStats(otherLake, { db, logger }, manages ? { actor } : { skipActivation: true });
    }
  }

  // Step 17. Post-hoc forensics, not a control - nothing alarms on this line; see the module
  // docblock.
  logger?.log?.('[dataLakes] lake file tags replaced', {
    dataLakeId: lake.id,
    fabFileId,
    actor: { userId: actor.userId, isAdmin: actor.isAdmin },
    added: toAdd,
    removed: toRemove,
    retained,
    primaryTagCleared,
    otherLakesJoined: joins.map(j => j.lake.id),
    otherLakesLeft: leaves.map(l => l.lake.id),
  });

  // Step 18. `current` is scoped to THIS lake's prefix, like the other three arrays - not the
  // file's whole tag list, which can carry other lakes' membership and other users' private
  // categorization this actor has no standing to see (the same reasoning that keeps this door
  // from returning the FabFile itself).
  const current = prefixArmTagNames(
    reconciled.map(t => t.name),
    prefix
  ).filter(name => !name.startsWith(DATALAKE_TAG_PREFIX));
  return {
    success: true,
    ...stats,
    tags: {
      added: toAdd,
      removed: toRemove,
      retained,
      current,
    },
  };
};
