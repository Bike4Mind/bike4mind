import type { AccessContext, IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { isDatalakeMetaTag, isRegistryDatalakeTag } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { assertLakeAccess, assertLakeWritable } from './assertLakeAccess';

/** The acting principal for a write/manage decision - resolved from auth, never the body. */
type ManageActor = Pick<AccessContext, 'userId' | 'isAdmin'>;

const ADD_DENIED = 'Only the creator can add files to this data lake';
/** Matches the wording `removeFileFromDataLake` uses, so both removal doors deny identically. */
const REMOVE_DENIED = 'Only the creator can remove files from this data lake';
/** Must stay in sync with `assertLakeWritable`, which cannot be reached from a bare meta-tag. */
const BUILT_IN_READ_ONLY = 'This data lake is built into the platform and is read-only';

/**
 * The single WRITE/MANAGE decision for a lake: platform admin, or the lake's creator. This is
 * the exact rule the remove path (`removeFileFromDataLake`) and the visibility change already
 * enforce inline - centralized here so every mutating path agrees on who may write.
 *
 * Deliberately narrower than `canAccessLake` (read): a tag/entitlement/org grant lets a member
 * READ a lake but NOT write into it. Injecting a file (applying the lake's meta-tag) is a write,
 * so it must clear this gate, closing the read-can-write asymmetry.
 */
export function canManageLake(lake: Pick<IDataLakeDocument, 'createdByUserId'>, actor: ManageActor): boolean {
  // Positive ownership: both ids must be PRESENT and equal. A bare `===` grants when both are
  // missing, which now costs data - this gate decides tag REMOVAL, not just addition.
  return actor.isAdmin || (!!lake.createdByUserId && lake.createdByUserId === actor.userId);
}

/**
 * Resolve a lake by id-or-slug and assert the caller may WRITE into it. Read access is checked
 * first (via the shared gate), so a caller who can't even see the lake gets a not-found (no
 * existence leak); a reader who isn't the creator/admin gets a manage-denied error mirroring the
 * remove path. Returns the lake on grant. Used by the batch upload doors, which already hold the
 * lake's id/slug.
 */
export const assertLakeWriteAccess = async (
  lakeIdOrSlug: string,
  ctx: AccessContext,
  { db }: { db: { dataLakes: Pick<IDataLakeRepository, 'findById' | 'findBySlug'> } }
): Promise<IDataLakeDocument> => {
  const lake = await assertLakeAccess(lakeIdOrSlug, ctx, { db });
  // Fallback lakes are read-only for EVERYONE (even admins, who pass canManageLake):
  // there is no document to attach files to.
  assertLakeWritable(lake);
  if (!canManageLake(lake, ctx)) {
    throw new BadRequestError(ADD_DENIED);
  }
  return lake;
};

type LakeTagAdapters = { dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag'> };

/** Resolve a meta-tag's lake and assert the actor may write into it, else throw `deniedMessage`. */
const assertManageableByTag = async (
  tagKey: string,
  actor: ManageActor,
  db: LakeTagAdapters,
  deniedMessage: string
): Promise<IDataLakeDocument> => {
  const lake = await db.dataLakes.findByDatalakeTag(tagKey);
  if (!lake || !canManageLake(lake, actor)) {
    throw new BadRequestError(deniedMessage);
  }
  return lake;
};

/**
 * Gate the file-tag write paths (Send-to-Data-Lake, direct create, tag toggle): given the
 * `datalake:*` meta-tags a caller is applying to a file, assert they may write into EVERY
 * referenced lake. Non-meta tags are ignored. A meta-tag that resolves to no lake, or to a lake
 * the caller can't manage, is rejected - this is the check that stops a read-only member from
 * injecting a file into a lake they don't own, mirroring the creator check on the remove path.
 *
 * Only sees tags being APPLIED, so it cannot gate a wholesale REPLACE (where an omitted tag is a
 * removal); `assertCanReplaceDataLakeTags` is the gate for that shape.
 */
export const assertCanWriteDataLakeTags = async (
  actor: ManageActor,
  // `readonly unknown[]`: some callers pass raw, un-validated tag names, so a malformed entry
  // (`{ name: null }`) can reach here. Narrowing to string makes a bad payload fail closed as a
  // 400, never a TypeError -> 500.
  tagNames: readonly unknown[],
  { db }: { db: LakeTagAdapters }
): Promise<void> => {
  // `datalakeTag` values are canonically lowercase (slug + hex org id), so normalize the lookup
  // key - a mixed-case meta-tag still resolves to (and is authorized against) its real lake.
  const metaTags = new Set(tagNames.filter(isDatalakeMetaTag).map(name => name.toLowerCase()));
  for (const tag of metaTags) {
    await assertManageableByTag(tag, actor, db, ADD_DENIED);
  }
};

/** One lake whose membership changed, so its cached stats have to be recomputed. */
export type AffectedDataLake = Pick<IDataLakeDocument, 'id' | 'datalakeTag'>;

/**
 * A wholesale tag replacement, as names. A named object rather than two positional arrays because
 * swapping `stored` and `next` would silently invert add/remove authorization.
 */
export interface DataLakeTagReplacement {
  /** Tag names the file currently carries. */
  stored: readonly unknown[];
  /**
   * Tag names the write will persist. Pass `stored` when the request omitted `tags` (nothing is
   * replaced), and `[]` when it sent something unreadable as an array - a malformed payload then
   * reads as removing everything and fails closed.
   */
  next: readonly unknown[];
  /** `primaryTag` the request sets, if any. Add-side only; it confers no membership anywhere. */
  primaryTag?: unknown;
  /** `primaryTag` already stored, so an unchanged (possibly stale) one is never re-gated. */
  storedPrimaryTag?: unknown;
}

/**
 * Gate a WHOLESALE tags replacement (`PUT /api/files/{id}`), where a meta-tag the body OMITS is a
 * lake REMOVAL. Authorizes every meta-tag added AND every one removed on the same creator/admin
 * terms, and reports the lakes on both sides so the caller can recompute their stats.
 *
 * Only the `datalake:*` meta-tag is gated, NOT a tag matching a lake's `fileTagPrefix` - even
 * though `buildOwnershipConditions` admits a file to a lake's browse on either signal, so
 * stripping a prefixed tag here IS an ungated eviction from that browse. The prefix cannot be
 * gated: it is user-chosen, non-unique across lakes and reserved only against the `datalake:`
 * namespace, so an ordinary tag like `acme:notes` collides with any stranger's lake configured
 * with `acme:`, and minting such a lake would freeze half the app's tag edits behind a 400. The
 * meta-tag is globally unique and reserved, so its presence is a trustworthy membership claim.
 *
 * Only the DIFF is authorized, so re-submitting a meta-tag the file already carries needs no
 * manage rights - the client renames a file by echoing its whole stored tag array back.
 */
export const assertCanReplaceDataLakeTags = async (
  actor: ManageActor,
  { stored, next, primaryTag, storedPrimaryTag }: DataLakeTagReplacement,
  { db }: { db: LakeTagAdapters }
): Promise<{ affectedLakes: AffectedDataLake[]; clearPrimaryTag: boolean }> => {
  const storedNames = new Set(stored.filter((name): name is string => typeof name === 'string'));
  const nextNames = new Set(next.filter((name): name is string => typeof name === 'string'));

  // Diff on RAW names. Both the meta-tag read arm and `computeDataLakeStats` match exactly, so
  // rewriting `datalake:x` to `DataLake:X` really does evict the file; folding case here would
  // read that as a no-op and authorize nothing. Lowercase builds the lookup key only.
  // Collapses names sharing a lookup key purely to save a duplicate findByDatalakeTag round-trip;
  // the once-per-lake recompute is guaranteed by keying `affected` on lake id, not by this.
  const dedupeByKey = (names: string[]): string[] => [
    ...new Map(names.map(name => [name.toLowerCase(), name])).values(),
  ];
  const added = [...nextNames].filter(name => isDatalakeMetaTag(name) && !storedNames.has(name));
  const removed = dedupeByKey([...storedNames].filter(name => isDatalakeMetaTag(name) && !nextNames.has(name)));
  // Pointing primaryTag at a lake the file is NOT already in is an add. Promoting a meta-tag the
  // file already carries is not: the UI's set-primary action sends primaryTag with no `tags` key,
  // so gating that would 400 a plain relabel. Nor is echoing a stale one back, or an orphaned
  // primaryTag could never be cleared.
  if (isDatalakeMetaTag(primaryTag) && !storedNames.has(primaryTag) && primaryTag !== storedPrimaryTag) {
    added.push(primaryTag);
  }

  // Keyed by lake id, not tag: a case rewrite puts one lake on BOTH sides and it must be
  // recomputed once.
  const affected = new Map<string, AffectedDataLake>();
  // Added first, so an add-only request still fails with the long-standing add-denied message.
  for (const name of dedupeByKey(added)) {
    const lake = await assertManageableByTag(name.toLowerCase(), actor, db, ADD_DENIED);
    affected.set(lake.id, { id: lake.id, datalakeTag: lake.datalakeTag });
  }
  for (const name of removed) {
    const tagKey = name.toLowerCase();
    const lake = await db.dataLakes.findByDatalakeTag(tagKey);
    if (!lake) {
      // A built-in lake has no document, so an unresolved tag can still name a REAL, live lake -
      // read-only for everyone, exactly as the DELETE path enforces via assertLakeWritable. Any
      // other unresolved tag names no lake at all, so allow it: blocking would strand the tag on
      // the file forever (DELETE 404s the missing lake and the toggle door rejects the tag).
      if (isRegistryDatalakeTag(tagKey)) {
        throw new BadRequestError(BUILT_IN_READ_ONLY);
      }
      continue;
    }
    if (!canManageLake(lake, actor)) {
      throw new BadRequestError(REMOVE_DENIED);
    }
    affected.set(lake.id, { id: lake.id, datalakeTag: lake.datalakeTag });
  }

  // A primaryTag naming a tag the file no longer carries is a wrong label, so an authorized
  // removal clears it - the same reason the DELETE path's pullTagsByFabFileId $unsets it. It does
  // NOT unblock a future request: the add rule above already ignores a primaryTag echoed back
  // unchanged. Matched case-insensitively, unlike that gate and unlike the sibling's exact $in,
  // because clearing a cosmetic label costs nothing if it fires a shade too eagerly.
  const effectivePrimaryTag = primaryTag !== undefined ? primaryTag : storedPrimaryTag;
  const clearPrimaryTag =
    typeof effectivePrimaryTag === 'string' &&
    removed.some(name => name.toLowerCase() === effectivePrimaryTag.toLowerCase());

  return { affectedLakes: [...affected.values()], clearPrimaryTag };
};
