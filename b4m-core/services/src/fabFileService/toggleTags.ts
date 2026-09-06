import { z } from 'zod';
import { distinctIdCount } from '../utils/objectIds';
import { DATALAKE_TAG_PREFIX } from '@bike4mind/common';
import {
  IAdminSettingsRepository,
  IDataLakeAccessGrantRepository,
  IDataLakeRepository,
  IFabFileDocument,
  IFabFileRepository,
  IFileTagRepository,
  IScopedSettingsRepository,
  IUserDocument,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { assertLakeWritable } from '../dataLakeService/assertLakeAccess';
import { assertCanWriteStaticRegistryTags } from '../dataLakeService/authorizeLakeWrite';
import { canManageLake, isEffectiveOwner, resolveEffectiveOwnerIds } from '../dataLakeService/manageRule';
import { makeLakeGrantResolver } from '../dataLakeService/authorizeLakeManage';
import { createDataLakeFallbackTagger } from '../dataLakeService/fallbackLakeTags';
import { addFileToLake, removeFileFromLake, type MembershipLake } from '../dataLakeService/lakeMembership';
import { assertLakeAdmission } from '../dataLakeService/lakeAdmissionGate';
import {
  findPrefixArmChanges,
  loadPrefixArmCandidateLakes,
  type PrefixArmChange,
} from '../dataLakeService/prefixArmMembership';
import { recomputeLakeStats } from '../dataLakeService/recomputeLakeStats';
import type { LakeConfigAuditAdapters } from '../dataLakeService/recordLakeConfigChange';

const fabFileToggleTagsSchema = z.object({
  ids: z.array(z.string()),
  tags: z.array(z.string()),
});

interface FabFileToggleTagsAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    fabFiles: Pick<
      IFabFileRepository,
      'shareable' | 'findById' | 'pullTagsByFabFileId' | 'pushTagsByFabFileId' | 'computeDataLakeStats'
    >;
    fileTags: Pick<IFileTagRepository, 'touchLastActivityBy'>;
    dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag' | 'setStats' | 'activateIfDraft' | 'find'>;
    // Optional: absent -> manage falls back to createdByUserId + org rung (see loadActiveLakeGrants).
    dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByLake' | 'listActiveByLakes'>;
    users: { findById: (id: string) => Promise<IUserDocument | null> };
    // The admission contract's lever (#1680) resolves from these. `adminSettings` is REQUIRED so a
    // door cannot quietly opt out of the contract by omitting it; the gate itself still reads
    // nothing unless a lake being JOINED declares a required passage size. `scopedSettings` is
    // optional - without it the lever resolves to its platform value rather than failing.
    adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
    scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
  };
  /** Forwarded to the fallback tagger's skip-path diagnostics; never fails the write on its own. */
  logger?: { warn?: (msg: string, ...args: unknown[]) => void };
}

const storedTagNames = (file: Pick<IFabFileDocument, 'tags'>): string[] =>
  (file.tags ?? []).map(t => t?.name).filter((name): name is string => typeof name === 'string');

const isDataLakeTag = (tag: string): boolean => tag.toLowerCase().startsWith(DATALAKE_TAG_PREFIX);

/**
 * How many lakes this call joined a file to solely by a `fileTagPrefix` content tag, with no
 * `datalake:*` meta-tag ever applied - the trap this field exists to surface. A count, not the
 * joined lakes' ids/tags: the batch is resolved against `shareable.findAllAccessibleByIds`, which
 * admits read-share access, so the caller applying the tag may not be entitled to see the lake
 * this file's OWNER was joined to (it is resolved from the file's owner, not the caller - see
 * `loadPrefixArmCandidateLakes`). The one consumer only ever reduces this to "did anything join,
 * and roughly how much", so a count is all it needs.
 */
export type ToggledFabFile = IFabFileDocument & {
  prefixArmJoinedLakeCount?: number;
};

/**
 * The one toggle decision `toggleOrdinaryTag` (the real write) and `predictToggleResult` (its
 * speculative fold, used only to decide the prefix-arm gate) must never disagree on: which stored
 * spellings of `tag` are already present, matched case-insensitively. Both derive from this
 * instead of each re-implementing the match, so the two cannot drift apart the way the bug this
 * PR fixes did.
 */
const matchingStoredNames = (storedNames: readonly string[], tag: string): string[] => {
  const key = tag.toLocaleLowerCase();
  return storedNames.filter(name => name.toLocaleLowerCase() === key);
};

/**
 * Flip each named tag on or off for each named file: a tag the file already carries is removed,
 * one it does not is added.
 *
 * A `datalake:*` meta-tag is NOT an ordinary tag - it is what makes a file a MEMBER of a lake, so
 * toggling one is a lake join or leave and is routed through the shared membership writes instead
 * of being written here. A file's ONLY membership signal for a lake can also be a `fileTagPrefix`
 * content tag with no meta-tag at all; toggling that off is likewise gated and swept through the
 * membership writes (see `finalizePrefixArmLeaves`), not left to `toggleOrdinaryTag`'s plain
 * pull. Lake stats are recomputed once per touched lake, not once per file.
 *
 * Both directions are element-level atomic writes. The whole `tags` array is never rewritten:
 * that let a slow writer's snapshot resurrect a tag a concurrent removal from a DIFFERENT lake
 * had just pulled. Stored casing survives in both directions - the name to remove is resolved
 * from the document, and a new name is written as the caller spelled it rather than lowercased.
 *
 * The accessibility check, the prefix-arm manage gate and the admission contract (#1680) are all
 * all-or-nothing and run before any write, but the writes themselves are not transactional: if one
 * file fails mid-batch, the files already written stay written. Every write is idempotent, so
 * retrying the same call converges rather than double-applying.
 */
export const toggleTags = async (
  userId: string,
  params: unknown,
  { db, logger }: FabFileToggleTagsAdapters
): Promise<ToggledFabFile[]> => {
  const { ids, tags: requestedTags } = fabFileToggleTagsSchema.parse(params);

  // Toggling one tag twice in a request is meaningless, and acting on it twice is harmful: the
  // second pass reads the same pre-write snapshot, so it repeats the write - toggling the tag back
  // off. Case-insensitively, because that is how a tag is matched below.
  const seen = new Set<string>();
  const tags = requestedTags.filter(tag => {
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Get user for permission checks
  const user = await db.users.findById(userId);
  if (!user) throw new Error('User not found');

  // Only get files that the user has update access to
  const fabFiles = await db.fabFiles.shareable.findAllAccessibleByIds(user, ids);

  // Check if user has permission to update all requested files. Counted as a Set for the same
  // reason `tags` is deduped above: the reader returns distinct rows, so a file sent twice is not
  // one that could not be reached, and every write here is idempotent.
  if (fabFiles.length !== distinctIdCount(ids)) {
    // BadRequestError, not a bare Error - see projectService/addFiles.
    throw new BadRequestError('Some files are not accessible or you do not have permission to edit them');
  }

  const actor = { userId, isAdmin: !!user.isAdmin };
  // Grant-aware manage gates below: consult each lake's active grants so a transferred lake's
  // superseded creator does not still pass. Batched + cached across both prefix-arm gate passes.
  // (This file-tag door is file-owner-centric and does not resolve the org-admin rung; org admins
  // manage lakes through the dedicated data-lake endpoints.)
  const grantResolver = makeLakeGrantResolver({ db });

  // A lake a file belongs to ONLY via its prefix arm (no meta-tag) is invisible to
  // toggleLakeMembership above, which only recognizes `datalake:*` names - so dropping that
  // file's last tag under the lake's prefix here would otherwise skip both the manage-rights
  // gate and the stats recompute. Resolved and gated for the WHOLE batch up front, before any
  // write: files are toggled concurrently below, so a mid-batch throw would leave one file
  // half-toggled while this gate is meant to be all-or-nothing (mirrors reconcileLakeTags).
  //
  // `toggleOrdinaryTag` itself stays lake-unaware: "is this the file's last prefix signal" is not
  // a per-tag property when a request can drop two tags under the same prefix at once.
  const predictToggleResult = (currentNames: string[], requestedTags: readonly string[]): string[] => {
    let result = currentNames;
    for (const tag of requestedTags) {
      const matches = matchingStoredNames(result, tag);
      result = matches.length > 0 ? result.filter(name => !matches.includes(name)) : [...result, tag];
    }
    return result;
  };

  const prefixLeavesByFile = new Map<string, PrefixArmChange[]>();
  const prefixJoinsByFile = new Map<string, PrefixArmChange[]>();
  // Short-circuits the whole thing (no query) when nothing requested could carry a prefix arm -
  // every usable prefix ends in ':' (see `prefixArmTagNames`), and a meta-tag never matches one.
  // The static-registry gate below rides on this same condition: normalizeTagPrefix requires a
  // trailing ':' too, so a registry-prefixed tag always contains one - but nothing enforces that
  // coupling, so narrowing this condition for the prefix-arm case alone would silently disable
  // the registry gate as well.
  if (tags.some(tag => !isDataLakeTag(tag) && tag.includes(':'))) {
    const candidateLakes = await loadPrefixArmCandidateLakes(
      fabFiles.map(f => f.userId),
      { db }
    );
    await Promise.all(
      fabFiles.map(async file => {
        const currentTagNames = storedTagNames(file);
        const resultingTagNames = predictToggleResult(currentTagNames, tags);
        // Gate only tags NEWLY becoming present: a non-admin toggling OFF a legacy tag they
        // already carry under a registry prefix (predating this gate) must still be able to,
        // matching reconcileLakeTags' whole-array counterpart.
        const newlyAppearing = resultingTagNames.filter(name => !currentTagNames.includes(name));
        assertCanWriteStaticRegistryTags(actor, newlyAppearing);
        const { leaves, joins } = await findPrefixArmChanges(
          { fileOwnerUserId: file.userId, currentTagNames, resultingTagNames },
          { db, candidateLakes }
        );
        if (leaves.length > 0) prefixLeavesByFile.set(file.id, leaves);
        if (joins.length > 0) prefixJoinsByFile.set(file.id, joins);
      })
    );
    const gatedLeaveLakes = [...prefixLeavesByFile.values()].flat().map(({ lake }) => lake);
    const gatedJoinLakes = [...prefixJoinsByFile.values()].flat().map(({ lake }) => lake);
    await grantResolver.prime([...gatedLeaveLakes, ...gatedJoinLakes]);
    for (const leaves of prefixLeavesByFile.values()) {
      for (const { lake } of leaves) {
        if (!canManageLake(lake, actor, grantResolver.get(lake.id))) {
          throw new BadRequestError('You do not have permission to remove files from this data lake');
        }
        assertLakeWritable(lake);
      }
    }

    // The admission contract (#1680) for the OTHER membership signal. A prefix-arm join makes a
    // file a member with no `datalake:*` meta-tag involved, so gating only the meta-tag path would
    // leave half the door open. Run in this same all-or-nothing pre-write pass as the leave gate
    // above: the writes below are concurrent, so refusing mid-batch would leave some files written.
    // Only JOINS are graded - a leave is never refused for a contract the file is exiting.
    //
    // ONE CALL PER FILE, deliberately: `assertLakeAdmission` grades every member it is handed
    // against every lake it is handed, so flattening this into a single call would check file A
    // against a lake only file B is joining and invent violations that do not exist. Do not
    // "optimize" it into one call without first grouping files by an identical join set.
    for (const file of fabFiles) {
      const joins = prefixJoinsByFile.get(file.id);
      if (!joins) continue;
      await assertLakeAdmission(
        joins.map(({ lake }) => lake),
        [{ id: file.id, userId: file.userId, chunkedPassageTokenTarget: file.chunkedPassageTokenTarget }],
        { db, logger }
      );
    }
  }

  const touchedTags = new Set<string>();
  const lakesByTag = new Map<string, Promise<MembershipLake>>();
  const touchedLakes = new Map<string, MembershipLake>();
  // Membership via a prefix-arm join is automatic (the read-side predicate grants it purely on
  // the tag, no permission check), but recomputeLakeStats's activation side effect is gated - see
  // finalizePrefixArmLeaves. An unmanaged join lands here instead of touchedLakes, so its stats
  // still get corrected (skipping activation) rather than drifting forever. Checked against
  // touchedLakes before recomputing, so a lake this actor DOES manage elsewhere in the same
  // batch isn't redundantly recomputed a second time with activation suppressed.
  const statsOnlyLakes = new Map<string, MembershipLake>();
  // One tagger for the whole request: it memoizes the lake lookup per meta-tag, so a bulk toggle
  // into one lake costs a single extra read, not one per file.
  const applyFallbackTags = createDataLakeFallbackTagger({ db, logger });

  // One lookup per distinct meta-tag rather than one per (file, tag) pair. The PROMISE is cached,
  // not its result: files are processed concurrently, so caching only on resolve would let every
  // file in the batch issue its own lookup before the first one came back.
  const resolveLake = (tag: string): Promise<MembershipLake> => {
    // datalakeTag values are canonically lowercase, so a mixed-case meta-tag still resolves to
    // its real lake - the same normalization the route-level gate applies.
    const key = tag.toLowerCase();
    const cached = lakesByTag.get(key);
    if (cached) return cached;
    const pending = db.dataLakes.findByDatalakeTag(key).then(lake => {
      if (!lake) {
        // Same refusal the route-level gate gives, so a meta-tag naming no lake is rejected
        // identically whichever check sees it first. Direction-neutral: this resolves the lake
        // before the join/leave decision, so it cannot know which way the toggle was going.
        throw new BadRequestError("Only the creator can change this data lake's files");
      }
      return lake;
    });
    lakesByTag.set(key, pending);
    return pending;
  };

  // The admission contract (#1680) for the meta-tag arm, in the same all-or-nothing pre-write pass
  // the prefix-arm gate above uses and for the same reason: files are toggled CONCURRENTLY below,
  // so a refusal raised next to the write would leave earlier files already joined behind a throw
  // that reads to the caller as "nothing happened".
  //
  // Hoisting cannot disagree with `toggleLakeMembership` about which toggles are joins: that
  // function decides direction from `storedTagNames(file)` - the same pre-write snapshot read here,
  // never re-read - and `tags` is deduped, so no tag flips direction mid-request. Only JOINS are
  // graded; a leave is never refused for a contract the file is exiting.
  //
  // ONE CALL PER FILE, deliberately: `assertLakeAdmission` grades every member it is handed against
  // every lake it is handed, so flattening this would check file A against a lake only file B is
  // joining and invent violations that do not exist.
  if (tags.some(isDataLakeTag)) {
    const metaJoinsByFile = new Map<string, MembershipLake[]>();
    for (const file of fabFiles) {
      const currentNames = storedTagNames(file);
      const joiningLakes: MembershipLake[] = [];
      for (const tag of tags) {
        if (!isDataLakeTag(tag)) continue;
        const lake = await resolveLake(tag);
        if (!currentNames.includes(lake.datalakeTag)) joiningLakes.push(lake);
      }
      if (joiningLakes.length > 0) metaJoinsByFile.set(file.id, joiningLakes);
    }
    await grantResolver.prime([...metaJoinsByFile.values()].flat());

    // Same cold-add ownership conjunct `addFileToDataLake` applies before its call into this same
    // `addFileToLake` write (see its docblock): membership IS read access (the meta-tag arm of
    // `buildDataLakeMembershipFilter` carries no ownership conjunct), so admitting any manage-gate
    // rung to stamp the tag on a file it does not own would publish a non-consenting owner's
    // private, merely read-shared file to every reader of the lake. `addFileToLake` itself cannot
    // carry this check - `addFileToDataLake`'s restore path calls it deliberately WITHOUT one - so
    // it is graded here, in the same all-or-nothing pre-write pass as the admission contract below.
    for (const file of fabFiles) {
      const joiningLakes = metaJoinsByFile.get(file.id);
      if (!joiningLakes) continue;
      for (const lake of joiningLakes) {
        const grants = grantResolver.get(lake.id);
        const isOwner =
          file.userId === actor.userId ||
          ((actor.isAdmin || isEffectiveOwner(lake, actor, grants)) &&
            resolveEffectiveOwnerIds(lake, grants).includes(file.userId));
        if (!isOwner) {
          throw new BadRequestError('You do not have permission to add files to this data lake');
        }
      }
    }

    for (const file of fabFiles) {
      const joiningLakes = metaJoinsByFile.get(file.id);
      if (!joiningLakes) continue;
      await assertLakeAdmission(
        joiningLakes,
        [{ id: file.id, userId: file.userId, chunkedPassageTokenTarget: file.chunkedPassageTokenTarget }],
        { db, logger }
      );
    }
  }

  const toggleLakeMembership = async (file: IFabFileDocument, tag: string): Promise<void> => {
    const lake = await resolveLake(tag);
    // Direction is decided on an EXACT match of the lake's canonical meta-tag - the same test
    // removeFileFromLake applies, so the two cannot disagree about which way to go. Two
    // consequences, both deliberate: a file carrying only the lake's prefixed tag gains the
    // meta-tag rather than counting as a member, and a meta-tag stored in some other casing (no
    // read arm matches it, so it grants no membership) is left alone while the canonical tag is
    // stamped.
    const isMember = storedTagNames(file).includes(lake.datalakeTag);
    if (!isMember) {
      // This branch, and only this branch, makes the file a MEMBER - but the admission contract
      // (#1680) it must satisfy is graded in the pre-write pass above, not here, so a refusal cannot
      // land after earlier files in the batch have already joined. This function stays write-only.
      await addFileToLake(actor, lake, file.id, { db });
    } else {
      try {
        await removeFileFromLake(actor, lake, file.id, { db });
      } catch (error) {
        // A concurrent removal landing between the read above and this write leaves nothing to
        // remove, which is the state the caller asked for anyway.
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    // Touched only once the write actually lands (or hits the benign race above): both
    // addFileToLake and removeFileFromLake throw their manage-rights gate's BadRequestError
    // before any write, and that throw exits this function before reaching here - so a rejected
    // toggle never triggers recomputeLakeStats's activateIfDraft side effect on a lake this actor
    // cannot manage. The same treatment the prefix-arm join below already gets.
    touchedLakes.set(lake.id, lake);
  };

  const toggleOrdinaryTag = async (file: IFabFileDocument, tag: string): Promise<void> => {
    // Every stored casing, not just the first: legacy data can hold both `Foo` and `foo`, and
    // removing one while leaving the other reports the tag as off while it still matches.
    const present = matchingStoredNames(storedTagNames(file), tag);
    if (present.length > 0) {
      await db.fabFiles.pullTagsByFabFileId(file.id, present);
      // Not gated on the pull's return: timestamps make it report a modification even when nothing
      // matched, so a concurrent removal of the same tag would still mark it touched here. Harmless
      // for a timestamp - the user did act on this tag either way.
      touchedTags.add(tag);
      return;
    }
    // The push's return IS truthful - a name already present fails its filter and counts 0 - so
    // gate on it rather than on the pre-write snapshot, which a concurrent add makes stale.
    const inserted = await db.fabFiles.pushTagsByFabFileId(file.id, [tag]);
    if (inserted > 0) touchedTags.add(tag);
  };

  /**
   * Sweep every prefix-arm leave/join this file was gated for above. Runs AFTER the per-tag
   * toggle loop (running it first would pull the prefix tags, and then `toggleOrdinaryTag` - a
   * TOGGLE, not a delete - would find them absent and re-add them) and BEFORE
   * `backfillLakeContentTags` (which re-reads the document; the sweep's pull must be visible to
   * that read, or the tagger judges satisfaction against a stale array).
   */
  const finalizePrefixArmLeaves = async (file: IFabFileDocument): Promise<void> => {
    for (const { lake } of prefixLeavesByFile.get(file.id) ?? []) {
      // Touched before the write, unlike toggleLakeMembership's meta-tag leave above - safe here
      // only because every prefix-arm leave's canManageLake gate already ran for the WHOLE batch
      // up front (see the loop above resolving prefixLeavesByFile), before this ever runs.
      touchedLakes.set(lake.id, lake);
      try {
        await removeFileFromLake(actor, lake, file.id, { db });
      } catch (error) {
        // The toggle loop above already pulled the tag, so "nothing to remove" is the NORMAL
        // outcome here, not a race - this still runs to sweep a signal a concurrent writer
        // re-added between the loop and here.
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    // MEMBERSHIP needs no gate here (the read-side predicate grants it purely on the tag), but
    // recomputeLakeStats's activation side effect is stronger: it also flips a draft lake to
    // active (activateIfDraft), a one-way, publication-visibility change. `file.userId` is the
    // file's OWNER, not necessarily this actor - `findAllAccessibleByIds` admits a read/write
    // share, so an unrelated sharee could otherwise force-publish a lake they have no
    // relationship to. Gated on canManageLake; an unmanaged join still gets its stats corrected
    // via statsOnlyLakes, just never the activation.
    for (const { lake } of prefixJoinsByFile.get(file.id) ?? []) {
      if (canManageLake(lake, actor, grantResolver.get(lake.id))) touchedLakes.set(lake.id, lake);
      else statsOnlyLakes.set(lake.id, lake);
    }
  };

  /**
   * Backfill the lake-content-tag invariant for the WHOLE file, not just lakes this call touched
   * (see `fallbackLakeTags`): a join above stamps only the meta-tag, and an ordinary-tag removal
   * elsewhere in this same loop can strip a file's last qualifying tag for a lake it remains a
   * member of, with no meta-tag ever mentioned in this request. Re-reads because the writes above
   * are element-level atomic ops with no returned document, so the in-memory `file` is stale the
   * moment any of them runs.
   *
   * Retraction (a departed lake's own stamp) is part of the tagger's contract but never actually
   * fires here in practice: a real leave already strips every tag under that lake's prefix inside
   * `removeFileFromLake`, so nothing is left by the time this reads the file back. Handled anyway
   * rather than assumed away, since the tagger's return is the source of truth either way.
   *
   * Cannot re-add a fallback tag for a lake `finalizePrefixArmLeaves` just left via its prefix
   * arm: the tagger derives its stamp set from `extractDataLakeMetaTags(currentTags)`, and a
   * prefix-arm-only lake has no meta-tag by definition - it was never in that set to begin with.
   */
  const backfillLakeContentTags = async (file: IFabFileDocument): Promise<void> => {
    const priorTags = file.tags ?? [];
    // Skipped when neither this request nor the file's prior state touched a lake at all, so a
    // plain tag edit on a file with no lake membership costs nothing beyond the toggles above.
    if (!tags.some(isDataLakeTag) && !priorTags.some(t => isDataLakeTag(t?.name ?? ''))) return;

    const freshFile = await db.fabFiles.findById(file.id);
    const currentTags = freshFile?.tags ?? [];
    const reconciled = await applyFallbackTags(currentTags, { previousTags: priorTags });

    const currentNames = new Set(currentTags.map(t => t.name));
    const reconciledNames = new Set(reconciled.map(t => t.name));
    const toAdd = reconciled.filter(t => !currentNames.has(t.name));
    const toRemove = [...currentNames].filter(name => !reconciledNames.has(name));

    // All fallback additions share the reconciler's stamped strength, so one push covers them.
    if (toAdd.length > 0)
      await db.fabFiles.pushTagsByFabFileId(
        file.id,
        toAdd.map(t => t.name),
        toAdd[0].strength
      );
    if (toRemove.length > 0) await db.fabFiles.pullTagsByFabFileId(file.id, toRemove);
  };

  // Tags are applied one at a time within a file - they mutate the same document - while files
  // are processed concurrently. allSettled rather than all, so every write has finished before
  // the stats below are recomputed: a rejection must not let the recompute race a write that is
  // still in flight.
  const outcomes = await Promise.allSettled(
    fabFiles.map(async file => {
      for (const tag of tags) {
        if (isDataLakeTag(tag)) {
          await toggleLakeMembership(file, tag);
        } else {
          await toggleOrdinaryTag(file, tag);
        }
      }
      await finalizePrefixArmLeaves(file);
      await backfillLakeContentTags(file);
    })
  );

  for (const lake of touchedLakes.values()) {
    await recomputeLakeStats(lake, { db, logger }, { actor });
  }
  for (const lake of statsOnlyLakes.values()) {
    if (!touchedLakes.has(lake.id)) await recomputeLakeStats(lake, { db, logger }, { skipActivation: true });
  }

  // Lake meta-tags are deliberately absent from this set: they are lake membership, not entries in
  // the user's own tag list, and no other lake door touches the tag registry.
  await Promise.all([...touchedTags].map(tag => db.fileTags.touchLastActivityBy({ name: tag, userId })));

  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failure) throw failure.reason;

  // Re-read: the writes above are element-level, so the documents loaded earlier no longer
  // reflect what is stored.
  const freshFiles = await db.fabFiles.shareable.findAllAccessibleByIds(user, ids);

  // Surfaces the trap: a content-prefix tag can join a file to a lake with no
  // `datalake:*` meta-tag ever applied, and the caller who reached for an ordinary tag has no way
  // to know that happened. Attached per-file rather than returned as a separate list, since the
  // route's response shape is an `IFabFileDocument[]` other callers already depend on - this rides
  // along as an extra property on the documents they already receive instead of changing it.
  //
  // `.toJSON()` FIRST: `freshFiles` are hydrated Mongoose documents (`shareable.findAllAccessibleByIds`
  // does not lean or serialize them), and `res.json` on the route above serializes via the schema's
  // `toJSON`, which only sees `_doc` plus declared virtuals - a bare own-property assigned onto the
  // live document is silently dropped before it reaches the wire. Converting to a plain object first
  // makes the property an ordinary key that survives JSON.stringify.
  return freshFiles.map(file => {
    const joins = prefixJoinsByFile.get(file.id);
    // `IFabFileDocument` is a plain-data interface with no `toJSON` of its own - the runtime value
    // here is the hydrated Mongoose document `shareable.findAllAccessibleByIds` actually returns.
    const plain = (file as unknown as { toJSON(): IFabFileDocument }).toJSON() as ToggledFabFile;
    if (!joins || joins.length === 0) return plain;
    plain.prefixArmJoinedLakeCount = joins.length;
    return plain;
  });
};
