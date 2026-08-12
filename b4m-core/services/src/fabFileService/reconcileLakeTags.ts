import { DATALAKE_TAG_PREFIX, DATALAKE_TAG_STRENGTH, prefixArmTagNames } from '@bike4mind/common';
import type { IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { assertLakeWritable } from '../dataLakeService/assertLakeAccess';
import {
  assertCanWriteStaticRegistryTags,
  canManageLake,
  extractDataLakeMetaTags,
  extractStaticRegistryPrefixedTags,
  isStaticRegistryDatalakeTag,
} from '../dataLakeService/authorizeLakeWrite';
import { reconcileDataLakeFallbackTags } from '../dataLakeService/fallbackLakeTags';
import type { MembershipActor, MembershipLake } from '../dataLakeService/lakeMembership';
import { findPrefixArmChanges, loadPrefixArmCandidateLakes } from '../dataLakeService/prefixArmMembership';
import { recomputeLakeStats } from '../dataLakeService/recomputeLakeStats';

interface ReconcileLakeTagsAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findById' | 'computeDataLakeStats'>;
    dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag' | 'setStats' | 'activateIfDraft' | 'find'>;
  };
  /** Forwarded to the fallback tagger's skip-path diagnostics; never fails the write on its own. */
  logger?: { warn?: (msg: string, ...args: unknown[]) => void };
  /**
   * The FILE's owner - the prefix-arm membership predicate is anchored here, NOT the acting
   * user (a shared-edit file's owner can differ from whoever is editing it). Omitted, it is
   * resolved via `db.fabFiles.findById`, so a caller that forgets to pass it does not silently
   * lose the check.
   */
  fileOwnerUserId?: string;
}

export interface LakeTagReconciliation {
  /**
   * The tag array to persist. Every meta-tag or prefix-arm content tag the file currently holds
   * membership through is kept here regardless of what the caller sent, so a whole-array write can
   * never drop membership out from under it.
   */
  tagsToPersist: { name: string; strength: number }[];
  /** Run AFTER the tag array is persisted. Applies any new joins, then recomputes stats. */
  commit: () => Promise<void>;
}

const isMetaTag = (name: string): boolean => name.toLowerCase().startsWith(DATALAKE_TAG_PREFIX);

/**
 * Reconcile the lake membership implied by a WHOLE-ARRAY tag replacement (the shape
 * `PUT /api/files/:id` and session summarization send) against what the file currently holds.
 *
 * A whole array is not a reliable signal of intent to leave: a client holding a copy fetched
 * before the last membership change resends it on an unrelated edit and, read literally, that
 * looks identical to "the user removed this tag." So this door can only ever JOIN a lake or
 * PRESERVE existing membership - never LEAVE one, for either mechanism (a `datalake:` meta-tag,
 * or a content tag matching a lake's `fileTagPrefix`), and for both a Mongo-backed lake and the
 * static-registry namespace (see below - no owning document, but no DB round trip is needed to
 * preserve one either). Through THIS door, the only ways to remove that membership are the
 * single-tag toggle (`POST /api/files/tags/toggle`, which never reaches this function - it calls
 * `findPrefixArmChanges` and the membership repository itself) and the dedicated
 * `DELETE /api/data-lakes/:id/files/:fileId` route, both unambiguous explicit actions with no
 * staleness window. (A user's own bulk tag-management doors - deleting or renaming a tag across
 * every file they own - are a separate, already-gated mechanism outside this door's scope; see
 * `tagService/remove.ts` and `tagService/update.ts`.)
 *
 * Preserving membership is not the same as leaving the CONTENT tags under it unprotected: an
 * actor who cannot manage a lake (no relation to it beyond a share on this one file) still gets
 * its meta-tag force-carried back, but any of that lake's content tags this write would otherwise
 * have DROPPED are force-carried too - see the `unmanagedPreservedLakes` and
 * `unmanagedDroppedPrefixNames` force-carries below. Without that, a mere file-share recipient
 * could use this whole-array door to strip another user's lake's content tags despite having no
 * rights over the lake itself. This protection is asymmetric by design and only covers REMOVAL:
 * adding a new content tag under a lake's prefix, or resending an existing one at a different
 * strength, stays ungated for any actor - that already was, and remains, today's "automatic
 * membership" model for content tags (see the mirror-case comment below). An unmanaged "rename"
 * (old name dropped, new name added) is therefore only half-blocked: the old tag is force-carried
 * back rather than lost, but the new one is still added alongside it.
 *
 * Because a JOIN needs no write beyond persisting the array itself (the caller's `tagsToPersist`
 * already carries the canonical meta-tag or content tag), `commit()` only ever recomputes stats -
 * there is nothing left to pull.
 *
 * A meta-tag that resolves to no lake is refused when the caller is trying to APPLY it, matching
 * the route gate; the same string being dropped is let through as a plain tag removal, since an
 * orphaned meta-tag left by a deleted lake must not make the file uneditable.
 *
 * `tagsToPersist` is also run through the fallback tagger (see `fallbackLakeTags`) before it is
 * returned, so a lake joined here without a real content tag still gets its `<prefix>uncategorized`
 * stamp, and a plain edit that happens to drop a file's last qualifying tag for a lake it remains a
 * member of gets it backfilled too. The tagger's retraction path is unreachable through this door:
 * this function never removes a lake's stamp on its own account, so there is nothing for it to
 * retract by the time it runs.
 *
 * Everything above is keyed by `datalake:*` META-TAGS. A lake a file belongs to ONLY via a
 * `fileTagPrefix` content tag - no meta-tag ever involved - is a second, independent join source
 * evaluated after the tagger runs; see the `findPrefixArmChanges` call below for that half. A
 * consequence worth stating plainly: a whole-array write can never drop a file's LAST tag under a
 * lake's prefix arm either, even if that was the caller's actual intent - the tag is force-carried
 * back in, silently, same as a meta-tag. Only the toggle and DELETE doors can end that membership.
 *
 * A THIRD concern sits ahead of all of it: `ordinaryTags` is also checked against the
 * static-registry namespace (e.g. `opti:`), which has no owning lake document at all. Only ADDING
 * a new static-registry-prefixed tag runs through `assertCanWriteStaticRegistryTags` (admin-only);
 * preserving one already held needs no such gate, and is handled by the
 * `droppedStaticRegistryNames` force-carry below, the content-tag mirror of the meta-tag preserve
 * a few lines up.
 */
export const reconcileLakeTags = async (
  actor: MembershipActor,
  fabFileId: string,
  currentTagNames: string[],
  desiredTags: { name: string; strength: number }[],
  { db, logger, fileOwnerUserId }: ReconcileLakeTagsAdapters
): Promise<LakeTagReconciliation> => {
  // `primaryTag` (a separate string field on the route, gated there against `datalake:*` meta-tags
  // alongside `tags`) is deliberately absent from `ordinaryTags`: no lake read arm consults
  // `primaryTag`, so it cannot carry static-registry membership the way a `tags` entry can.
  const ordinaryTags = desiredTags.filter(tag => !isMetaTag(tag.name));
  // Gate only NEWLY-appearing static-registry tags, not ones already stored: a whole-array write
  // must not brick an unrelated edit to a file that already illegitimately carries a legacy
  // registry-prefixed tag (predating this gate). Mirrors toggleTags' equivalent gate, so the two
  // whole-array/element-level doors cannot disagree about what a "join" is.
  const newlyAppearingOrdinaryNames = ordinaryTags.map(tag => tag.name).filter(name => !currentTagNames.includes(name));
  assertCanWriteStaticRegistryTags(actor, newlyAppearingOrdinaryNames);
  const desiredKeys = new Set(extractDataLakeMetaTags(desiredTags.map(tag => tag.name)));
  const currentKeys = new Set(extractDataLakeMetaTags(currentTagNames));

  const joins: MembershipLake[] = [];
  const metaTagsToPersist: string[] = [];
  // Lakes whose meta-tag is preserved above but whose CONTENT tags this actor has no standing to
  // touch - see the force-carry below, right after `resultingTagNames` is known.
  const unmanagedPreservedLakes: MembershipLake[] = [];

  for (const key of new Set([...desiredKeys, ...currentKeys])) {
    const wanted = desiredKeys.has(key);
    const lake = await db.dataLakes.findByDatalakeTag(key);

    if (!lake) {
      if (wanted) {
        throw new BadRequestError('Only the creator can add files to this data lake');
      }
      // A static-registry meta-tag (e.g. `datalake:opti-knowledge`) has no owning document, so it
      // hits this branch on every write, but it is still real membership and needs no DB round
      // trip to identify - preserve it the same as a Mongo-backed lake's meta-tag. An orphaned
      // meta-tag from a genuinely DELETED dynamic lake is the only case this door still drops.
      if (isStaticRegistryDatalakeTag(key)) metaTagsToPersist.push(key);
      continue;
    }

    // Membership is the CANONICAL tag, matched exactly, because that is what the read arm
    // matches. A meta-tag stored in any other casing confers nothing and is normalized away.
    const isMember = currentTagNames.includes(lake.datalakeTag);

    if (isMember) {
      // Always preserved, regardless of `wanted`: a whole-array write cannot distinguish an
      // intentional removal from a stale client's copy predating the last membership change, so
      // this door never leaves a lake on its own - see the toggle/DELETE doors for that.
      metaTagsToPersist.push(lake.datalakeTag);
      if (!canManageLake(lake, actor)) unmanagedPreservedLakes.push(lake);
    } else if (wanted) {
      metaTagsToPersist.push(lake.datalakeTag);
      joins.push(lake);
    }
  }

  for (const lake of joins) {
    if (!canManageLake(lake, actor)) {
      throw new BadRequestError('Only the creator can add files to this data lake');
    }
    assertLakeWritable(lake);
  }

  const tagsToPersist = [
    ...ordinaryTags,
    ...metaTagsToPersist.map(name => ({ name, strength: DATALAKE_TAG_STRENGTH })),
  ];
  // previousTags only needs names: the tagger reads nothing else off it, and the departed-lake
  // set it computes is what the doc comment above notes never actually finds anything to retract.
  const reconciledTags = await reconcileDataLakeFallbackTags(tagsToPersist, {
    db,
    logger,
    previousTags: currentTagNames.map(name => ({ name })),
  });

  // A lake a file belongs to ONLY via its prefix arm (no meta-tag) never appears in the loop
  // above, which is keyed by meta-tag - so a write that would otherwise drop that file's last tag
  // under the lake's prefix needs its own detection, purely to force-carry the tag back (below);
  // it is never gated or removed, for the same staleness reason the meta-tag branch preserves.
  // Evaluated against `reconciledTags` (post-tagger), not the raw array: the fallback tagger can
  // mint a nested stamp that re-satisfies a would-be-departing lake's prefix, and judging against
  // the pre-tagger array could force-carry a tag the persisted array already keeps.
  const cachedFile = fileOwnerUserId === undefined ? await db.fabFiles.findById(fabFileId) : undefined;
  const owner = fileOwnerUserId ?? cachedFile?.userId;
  if (owner === undefined) {
    // Not reachable from updateFabFile (resolves the file first) or the PUT route (authorizes it
    // first) - both always supply one of the two owner signals. Logged, not thrown: a
    // hypothetical future caller missing both should degrade to skipping prefix-arm
    // preservation, not fail the whole write.
    logger?.warn?.('reconcileLakeTags: could not resolve file owner; prefix-arm preservation skipped', fabFileId);
  }
  const resultingTagNames = reconciledTags.map(t => t.name);
  // Resolved once and reused for the unmanaged-prefix-drop check below - both need the same
  // owner-scoped candidate set, and querying it twice per write was pure I/O waste (a dropped,
  // non-meta content tag containing ':' is always already part of this diff too).
  const currentNameSet = new Set(currentTagNames);
  const resultingNameSet = new Set(resultingTagNames);
  const changedTagNames = [...new Set([...currentTagNames, ...resultingTagNames])].filter(
    name => !(currentNameSet.has(name) && resultingNameSet.has(name))
  );
  const prefixArmCandidateLakes = changedTagNames.some(name => name.includes(':'))
    ? await loadPrefixArmCandidateLakes([owner], { db })
    : [];
  const { leaves: prefixArmLeaves, joins: prefixArmJoins } = await findPrefixArmChanges(
    { fileOwnerUserId: owner, currentTagNames, resultingTagNames },
    { db, candidateLakes: prefixArmCandidateLakes }
  );
  // The mirror case: a write that newly satisfies a lake's prefix arm is automatic MEMBERSHIP
  // (today's accepted model for content tags - the read-side predicate grants it purely on the
  // tag, with no permission check either). But recomputeLakeStats's activation side effect is
  // stronger than membership: it also flips a draft lake to active (activateIfDraft), a one-way,
  // publication-visibility change. `owner` is the FILE's owner, not the acting user - a caller
  // merely SHARED on that file (findAccessibleById admits a read/write share) could otherwise
  // force-publish a lake they have no relationship to. Gate the ACTIVATION on canManageLake; an
  // unmanaged join still gets its stats corrected via statsOnlyJoins below (see commit()), rather
  // than drifting until some other door happens to touch the same lake.
  const statsOnlyJoins: MembershipLake[] = [];
  for (const j of prefixArmJoins) {
    if (canManageLake(j.lake, actor)) joins.push(j.lake);
    else statsOnlyJoins.push(j.lake);
  }

  // A DYNAMIC lake this actor cannot manage, reachable ONLY via a prefix content tag (no
  // meta-tag), is invisible to the loop above and to `prefixArmLeaves` unless the write empties
  // every one of its signal tags at once - a sibling tag surviving hides a partial drop from both.
  // So a dropped content tag is checked independently: does it name a prefix arm on a lake owned
  // by this file's owner that this actor cannot manage? If so it is force-carried below too, same
  // as the meta-tag-preserved case - without this, that lake's OWN content-tag taxonomy would be
  // rewritable by any file-share recipient, one sibling tag at a time.
  const droppedContentNames = currentTagNames.filter(name => !resultingTagNames.includes(name) && !isMetaTag(name));
  // Reuses `prefixArmCandidateLakes` resolved above instead of re-querying: any dropped, non-meta
  // tag containing ':' is necessarily part of `changedTagNames`, so that candidate set already
  // covers this check.
  const unmanagedDroppedPrefixNames = droppedContentNames.filter(name => {
    // .some(), not the first match: two lakes can share one fileTagPrefix, and this must force-
    // carry the name if EITHER matching lake is unmanaged, not just whichever is found first.
    const matchingLakes = prefixArmCandidateLakes.filter(l => prefixArmTagNames([name], l.fileTagPrefix).length > 0);
    return matchingLakes.some(l => !canManageLake(l, actor));
  });

  // Force-carried, mirroring metaTagsToPersist above, for three cases: (a) a prefix-arm-only lake
  // the array would otherwise have dropped the last qualifying tag for, (b) any content tag under
  // a META-TAG-preserved lake this actor cannot manage, and (c) `unmanagedDroppedPrefixNames`
  // above. (b)/(c) matter because the meta-tag preserve only protects membership, not the lake's
  // curated content-tag taxonomy - a mere file-share recipient (findAccessibleById admits a read/
  // write share) could otherwise use this whole-array door to silently strip or rewrite another
  // user's lake's content tags despite having no rights over that lake at all. (This does not
  // extend to a NEW content tag under a lake's prefix - adding one is today's accepted "automatic
  // membership" model for content tags, unchanged by this fix.) Restores each tag's ORIGINAL
  // strength (a content tag's strength is user-meaningful, unlike a meta-tag's fixed
  // DATALAKE_TAG_STRENGTH; a stored tag with none defaults to 0, matching every other content-tag
  // write in this codebase - never the meta-tag constant), so re-fetch the stored doc only on this
  // rare path. Deduped by name: two lakes sharing one prefix both list the same tag as their
  // signal, and it only needs carrying once.
  const unmanagedLakeContentNames = unmanagedPreservedLakes.flatMap(lake =>
    prefixArmTagNames(currentTagNames, lake.fileTagPrefix).filter(name => !resultingTagNames.includes(name))
  );
  // A static-registry content tag (e.g. `opti:report`) has no owning lake document either - see
  // the meta-tag branch's equivalent preserve above.
  const droppedStaticRegistryNames = extractStaticRegistryPrefixedTags(currentTagNames).filter(
    name => !resultingTagNames.includes(name)
  );
  let departingPrefixTags: { name: string; strength: number }[] = [];
  if (
    prefixArmLeaves.length > 0 ||
    unmanagedLakeContentNames.length > 0 ||
    unmanagedDroppedPrefixNames.length > 0 ||
    droppedStaticRegistryNames.length > 0
  ) {
    const storedFile = cachedFile ?? (await db.fabFiles.findById(fabFileId));
    const strengthByName = new Map((storedFile?.tags ?? []).map(t => [t.name, t.strength] as const));
    const departingNames = new Set([
      ...prefixArmLeaves.flatMap(l => l.signalTags),
      ...unmanagedLakeContentNames,
      ...unmanagedDroppedPrefixNames,
      ...droppedStaticRegistryNames,
    ]);
    departingPrefixTags = [...departingNames].map(name => ({
      name,
      // 0, not DATALAKE_TAG_STRENGTH: that constant is the meta-tag's fixed weight, not a
      // sensible default for a content tag stored without one (matches pushTagsByFabFileId's own
      // default elsewhere in this codebase).
      strength: strengthByName.get(name) ?? 0,
    }));
  }

  return {
    tagsToPersist: departingPrefixTags.length > 0 ? [...reconciledTags, ...departingPrefixTags] : reconciledTags,
    commit: async () => {
      // Joins need no write here: the caller has already persisted the canonical meta-tag (or,
      // for a prefix-arm join, the qualifying content tag) as part of `tagsToPersist`, and their
      // gate (where one applies) ran above, before that write. They still need stats.
      const recomputed = new Set<string>();
      for (const lake of joins) {
        await recomputeLakeStats(lake, { db });
        recomputed.add(lake.id);
      }
      // An unmanaged prefix-arm join: stats only, activation stays gated - see the comment above.
      for (const lake of statsOnlyJoins) {
        if (!recomputed.has(lake.id)) await recomputeLakeStats(lake, { db }, { skipActivation: true });
      }
    },
  };
};
