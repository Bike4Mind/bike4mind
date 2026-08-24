import type {
  AccessContext,
  IDataLakeAccessGrantRepository,
  IDataLakeBatchDocument,
  IDataLakeDocument,
  IDataLakeRepository,
  IFallbackLakeSettingsRepository,
} from '@bike4mind/common';
import { DATA_LAKES, DATALAKE_TAG_PREFIX, normalizeTagPrefix } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { assertLakeAccess, assertLakeWritable, isFallbackLake } from './assertLakeAccess';
import { type LakeAccessLogger } from './resolveLakeReadAccess';
import { type ManageActor } from './manageRule';
import { resolveCanManageLake } from './authorizeLakeManage';
import { assertLakeAdmission, type AdmissionMember } from './lakeAdmissionGate';
import { type ScopedSettingsDb } from '../settings/resolveScopedSetting';

export { canManageLake, type ManageActor } from './manageRule';

/**
 * Resolve a lake by id-or-slug and assert the caller may WRITE into it. Read access is checked
 * first (via the shared gate), so a caller who can't even see the lake gets a not-found (no
 * existence leak); a reader who isn't the creator/admin gets a manage-denied error mirroring the
 * remove path. Returns the lake on grant. Used by the batch upload doors, which already hold the
 * lake's id/slug.
 *
 * Fallback lakes are read-only for EVERYONE (even admins, who pass canManageLake): there is no
 * document to attach files to. `assertLakeRebuildAccess` below is the one file-level operation
 * that does not go through this gate - see its comment for why.
 */
export const assertLakeWriteAccess = async (
  lakeIdOrSlug: string,
  ctx: AccessContext,
  {
    db,
  }: {
    db: {
      dataLakes: Pick<IDataLakeRepository, 'findById' | 'findBySlug'>;
      dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    };
  }
): Promise<IDataLakeDocument> => {
  const lake = await assertLakeAccess(lakeIdOrSlug, ctx, { db });
  assertLakeWritable(lake);
  if (!(await resolveCanManageLake(lake, ctx, { db }))) {
    throw new BadRequestError('You do not have permission to add files to this data lake');
  }
  return lake;
};

/**
 * Resolve a lake by id-or-slug and assert the caller may REBUILD its passages (re-chunk files
 * already in the lake). Deliberately does NOT call `assertLakeWritable`: rebuild re-chunks
 * FabFiles carrying the lake's meta-tag, attaching nothing and mutating no lake document, so the
 * "there is no document to mutate" rationale that guards rename/delete/visibility/file-removal
 * does not apply here. Must stay in sync with `assertCanWriteStaticRegistryTags` /
 * `assertCanWriteDataLakeTags` below, which enforce the same "static registry lake -> admin only"
 * rule for the sibling operations of changing which files belong to a static lake.
 *
 * Fallback (static registry) lakes gate on `ctx.isAdmin` DIRECTLY, not `resolveCanManageLake`:
 * `resolveFallbackLake` spreads the lake's config onto its synthetic document, so an org-scoped
 * overlay lake would carry `organizationId` and let a customer-side org admin (not a platform
 * admin) pass `canManageLake`'s org-admin rung. Gating on `ctx.isAdmin` directly keeps this
 * predicate identical to the `canRebuild` flag computed in `listDataLakes.ts` for what each
 * decides. They are not identical in every path to that decision, though: `resolveFallbackLake`
 * (this gate's read step) applies the lake's org prerequisite before its `ctx.isAdmin` bypass, so
 * an admin outside an org-scoped lake's org is refused here even though `listAllDataLakes` (which
 * computes `canRebuild`) applies no such org filter to fallback lakes. That is a fail-CLOSED
 * mismatch (a lit-up button that 404s), not an exposure - narrower is always the safe direction.
 */
export const assertLakeRebuildAccess = async (
  lakeIdOrSlug: string,
  ctx: AccessContext,
  {
    db,
  }: {
    db: {
      dataLakes: Pick<IDataLakeRepository, 'findById' | 'findBySlug'>;
      dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    };
  }
): Promise<IDataLakeDocument> => {
  const lake = await assertLakeAccess(lakeIdOrSlug, ctx, { db });
  const allowed = isFallbackLake(lake) ? ctx.isAdmin : await resolveCanManageLake(lake, ctx, { db });
  if (!allowed) {
    throw new BadRequestError("You do not have permission to rebuild this data lake's passages");
  }
  return lake;
};

/**
 * Resolve a lake by id-or-slug and assert the caller may edit its FALLBACK SETTINGS OVERLAY (see
 * IFallbackLakeSetting) - currently `groundingMode` only. Exists only for a static registry lake: a
 * DB lake's settings live on its document and go through the ordinary `updateDataLake` write path
 * (PUT /api/data-lakes/:id), which this gate deliberately refuses so the two paths cannot both
 * claim to own a persisted lake's settings.
 *
 * Gates on `ctx.isAdmin` DIRECTLY, not `resolveCanManageLake` - same reasoning as
 * `assertLakeRebuildAccess`: a fallback lake's synthetic document (`resolveFallbackLake`) spreads
 * the registry config's `organizationId` onto it, so an org-scoped lake would let a customer-side
 * org admin (not a platform admin) pass `canManageLake`'s org-admin rung if this used it. Must stay
 * in sync with `canManageSettings` in `listDataLakes.ts`, which computes the identical predicate for
 * the UI affordance this gate enforces server-side.
 */
export const assertFallbackLakeSettingsWriteAccess = async (
  lakeIdOrSlug: string,
  ctx: AccessContext,
  {
    db,
    logger,
  }: {
    db: {
      dataLakes: Pick<IDataLakeRepository, 'findById' | 'findBySlug'>;
      dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
      /**
       * Declared, and non-optional, so the overlay merge cannot be lost by a caller that builds
       * exactly this type. It previously worked only by structural typing - the one route passes a
       * wider object - so a second caller assembling the minimal declared shape would have
       * typechecked green while every overlay field silently read as unset.
       */
      fallbackLakeSettings: Pick<IFallbackLakeSettingsRepository, 'findByLakeId'>;
    };
    // Forwarded so resolveFallbackLake's overlay-read failure is logged on the WRITE path too;
    // without it that catch is reachable here but permanently silent.
    logger?: LakeAccessLogger;
  }
): Promise<IDataLakeDocument> => {
  const lake = await assertLakeAccess(lakeIdOrSlug, ctx, { db, logger });
  if (!isFallbackLake(lake)) {
    throw new BadRequestError('This data lake has its own settings editor; use the standard update endpoint');
  }
  if (!ctx.isAdmin) {
    throw new BadRequestError("You do not have permission to change this data lake's settings");
  }
  return lake;
};

/**
 * The distinct `datalake:*` meta-tags in a raw tag-name list, lowercased for lookup
 * (`datalakeTag` values are canonically lowercase, so a mixed-case meta-tag still resolves to
 * its real lake).
 *
 * `readonly unknown[]`: some callers (e.g. PUT /api/files/{id}) pass raw, un-validated tag
 * names, so a malformed entry (`{ name: null }`) can reach here. Narrowing to string here makes
 * a bad payload fail closed at the caller, never a TypeError -> 500.
 *
 * Shared by the write GATE below and the fallback stamper (see `fallbackLakeTags`) so the two
 * cannot disagree about what counts as a meta-tag: a name one recognizes and the other does not
 * is either an ungated write or an unenforced invariant.
 */
export const extractDataLakeMetaTags = (tagNames: readonly unknown[]): string[] =>
  Array.from(
    new Set(
      tagNames
        .filter((name): name is string => typeof name === 'string')
        .map(name => name.toLowerCase())
        .filter(name => name.startsWith(DATALAKE_TAG_PREFIX))
    )
  );

/**
 * The `datalake:*` meta-tags naming a lake in the STATIC REGISTRY (e.g. `datalake:opti-knowledge`),
 * lowercased to match `extractDataLakeMetaTags`' normalization. These lakes have no owning DB
 * document by construction, so `db.dataLakes.findByDatalakeTag` always returns null for them -
 * without this arm, `assertCanWriteDataLakeTags` would refuse every write into a static lake
 * unconditionally, including the platform-admin ingest scripts that are the only supported way to
 * populate one.
 */
const STATIC_REGISTRY_DATALAKE_TAGS = new Set(DATA_LAKES.map(lake => lake.datalakeTag.toLowerCase()));

/**
 * Whether a `datalake:*` meta-tag names a STATIC REGISTRY lake rather than a DB-backed one.
 * Exported so a caller that needs to PREDICT this gate's decision without a DB round-trip (e.g.
 * a pre-filter dropping tags before a write it doesn't want to fail outright on) can ask the same
 * question `assertCanWriteDataLakeTags` answers internally, instead of re-deriving its own,
 * potentially drifted, notion of "unmanageable."
 */
export const isStaticRegistryDatalakeTag = (tag: string): boolean =>
  STATIC_REGISTRY_DATALAKE_TAGS.has(tag.toLowerCase());

/**
 * Gate the file-tag write paths (Send-to-Data-Lake, direct create/update, tag toggle): given the
 * `datalake:*` meta-tags a caller is applying to a file, assert they may write into EVERY
 * referenced lake. Non-meta tags are ignored. A meta-tag naming a STATIC REGISTRY lake is
 * admin-only (mirrors `assertCanWriteStaticRegistryTags`' rule for that lake's content-prefix
 * tags - there is no creator to check against). Any other meta-tag that resolves to no lake, or to
 * a lake the caller can't manage, is rejected - this is the check that stops a read-only member
 * from injecting a file into a lake they don't own, mirroring the creator check on the remove path.
 */
export const assertCanWriteDataLakeTags = async (
  actor: ManageActor,
  tagNames: readonly unknown[],
  {
    db,
    members,
    logger,
  }: {
    db: {
      dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag'>;
      // Optional: absent -> manage falls back to createdByUserId + org-admin (no grant supersession).
      // The file-create fan-in (email/url/generated/research) applies only its own/hardcoded tags,
      // so it need not wire the grant repo; user-facing tag doors that do, get full grant-awareness.
      dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    } & ScopedSettingsDb;
    /**
     * The files this write ADMITS into the named lakes, for the admission contract (#1680). Pass
     * resolved files (with `chunkedPassageTokenTarget`) where they are known, so an already-chunked
     * file is graded on what its chunks ARE rather than on what policy predicts they would be; at a
     * pre-upload door, where no FabFile exists yet, pass `[{ userId: <owner-to-be> }]` so the gate
     * predicts against the right owner's chunk policy.
     *
     * OMITTED means "nothing is being admitted" and the contract is skipped. That is the correct
     * default for this direction-NEUTRAL gate: it also sees tag REMOVALS, and a removal must never
     * be refused for a contract the file is leaving. A door that admits files opts IN by naming
     * them - never inferred from the actor, which would refuse removals at every toggle door.
     */
    members?: readonly AdmissionMember[];
    logger?: Logger;
  }
): Promise<void> => {
  const metaTags = extractDataLakeMetaTags(tagNames);
  const targetLakes: IDataLakeDocument[] = [];
  for (const tag of metaTags) {
    if (STATIC_REGISTRY_DATALAKE_TAGS.has(tag)) {
      if (!actor.isAdmin) {
        throw new BadRequestError("Only an admin can change this data lake's files");
      }
      continue;
    }
    const lake = await db.dataLakes.findByDatalakeTag(tag);
    if (!lake || !(await resolveCanManageLake(lake, actor, { db }))) {
      // Direction-neutral wording: this gate sees a tag payload, not an intent, so the same
      // refusal covers adding a file to the lake and removing one from it. Saying "add" here
      // told a caller their removal was refused for the wrong reason.
      throw new BadRequestError("You do not have permission to change this data lake's files");
    }
    targetLakes.push(lake);
  }

  // Authorization answered "may you write here"; the admission contract answers "will this content
  // be findable once it is here" (#1680). Same chokepoint on purpose: every door that writes a
  // CLIENT-SUPPLIED meta-tag already passes through here, so those cannot skip the contract.
  //
  // It is NOT a chokepoint for the whole contract. A door that resolves its lake server-side and
  // stamps the meta-tag itself has no client meta-tag for this function to see, so it must call
  // `assertLakeAdmission` explicitly - `generate-presigned-urls-batch`, `data-lakes/batches` and the
  // Drive folder sync (`driveLakeIngest`) each do. A new door of that shape needs its own call.
  //
  // The gate itself short-circuits (no settings read) when nothing is being admitted or no target
  // lake declares a passage policy - the common case - so this costs nothing on the ordinary path.
  if (members?.length) {
    await assertLakeAdmission(targetLakes, members, { db, logger });
  }
};

/**
 * The tag names in a raw list that fall under a STATIC REGISTRY lake's `fileTagPrefix` (e.g.
 * `opti:report`). These lakes have no owning DB document, so `canManageLake` and the prefix-arm
 * membership checks (both anchored to a lake's `createdByUserId`) never see them - a caller could
 * otherwise self-apply one with no gate at all.
 *
 * Case-SENSITIVE plain prefix match, deliberately not `satisfiesTagPrefix`'s stricter
 * category-worthiness rule (non-empty suffix): the read-side bypass this guards against
 * (`buildOwnershipConditions`'s OPEN prefix arm) builds an unflagged `^(prefix)` regex with no
 * suffix requirement, so a bare `opti:` would still leak through that arm and must be caught here
 * too.
 */
export const extractStaticRegistryPrefixedTags = (tagNames: readonly unknown[]): string[] => {
  const prefixes = DATA_LAKES.map(lake => normalizeTagPrefix(lake.fileTagPrefix)).filter(
    (prefix): prefix is string => prefix !== null
  );
  if (prefixes.length === 0) return [];
  return tagNames.filter(
    (name): name is string => typeof name === 'string' && prefixes.some(prefix => name.startsWith(prefix))
  );
};

/**
 * Gate a write against the STATIC REGISTRY namespace (e.g. `opti:`) the same way
 * `assertCanWriteDataLakeTags` gates `datalake:*` meta-tags: those lakes are a shared knowledge
 * base with no owning document, so only a platform admin may apply one of their content prefixes
 * to a file - never the lake's own read-side entitlement, which grants browsing, not writing.
 * Pure (no DB): the registry is a static, in-memory list.
 */
export const assertCanWriteStaticRegistryTags = (actor: ManageActor, tagNames: readonly unknown[]): void => {
  if (actor.isAdmin) return;
  if (extractStaticRegistryPrefixedTags(tagNames).length > 0) {
    throw new BadRequestError("Only an admin can change this data lake's files");
  }
};

/**
 * Assert that a batch and the lake a request resolved are the same lake. Every batch is created
 * for one lake (`dataLakeId` is required on it), which makes the batch the reliable authority on
 * where its files belong: a lake reference resolving anywhere else is a stale client value, not a
 * second target. A caller that names no lake is refused too - its files would otherwise land in
 * the batch of a lake they never joined.
 *
 * Bad request, not not-found: callers reach this only after being shown that both the lake and
 * the batch exist and are theirs.
 */
export const assertBatchBelongsToLake = (
  batch: Pick<IDataLakeBatchDocument, 'dataLakeId'>,
  lake: Pick<IDataLakeDocument, 'id'> | undefined
): void => {
  // A batch with no binding is the malformed side, so saying "name the lake" would blame a caller
  // who did name one. The other two cases really are the caller's to fix.
  if (!batch.dataLakeId) {
    throw new BadRequestError('This batch is not attached to a data lake');
  }
  if (!lake || batch.dataLakeId !== lake.id) {
    throw new BadRequestError('This upload must name the data lake its batch belongs to');
  }
};

/**
 * Assert that every `datalake:*` meta-tag in a payload names `lake` - the lake the request has
 * already resolved and authorized. The gate above answers "may you write there", not "is that
 * where these files are going", so a caller who can manage two lakes (any two, for an admin) can
 * otherwise hand one lake's upload the other lake's meta-tag.
 *
 * The lake's side is folded too: `datalakeTag` is canonically lowercase but nothing enforces that
 * on the way in, and a tag that IS the lake's own must be recognized rather than refused.
 */
export const assertMetaTagsMatchLake = (
  lake: Pick<IDataLakeDocument, 'datalakeTag'>,
  tagNames: readonly unknown[]
): void => {
  const expected = lake.datalakeTag?.toLowerCase();
  for (const tag of extractDataLakeMetaTags(tagNames)) {
    if (tag !== expected) {
      throw new BadRequestError('A data lake tag on these files names a different data lake');
    }
  }
};
