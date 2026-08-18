import {
  DATA_LAKES,
  normalizeTagPrefix,
  tagPrefixesOverlap,
  type IDataLakeDocument,
  type IDataLakeRepository,
} from '@bike4mind/common';

type PrefixScopeLake = Pick<IDataLakeDocument, 'id' | 'name' | 'fileTagPrefix' | 'createdByUserId'>;

interface PrefixCollisionAdapters {
  dataLakes: Pick<IDataLakeRepository, 'find'>;
}

/**
 * Lakes whose `fileTagPrefix` would fight with `rawPrefix` inside the given scope.
 *
 * Scope is same-org OR same-creator, because those are the only lakes whose prefix arms can
 * reach the same files: the arm only matches files the lake's creator OWNS, so two unrelated
 * personal lakes both using `docs:` cannot touch each other's files. Claiming a prefix globally
 * would instead let the first user to take `docs:` block everyone.
 *
 * Deliberately different from disambiguateSlug's org-less scope, which also matches other
 * org-less lakes: a slug has to be unique per scope because it mints the meta-tag, a prefix does
 * not. No status filter - a soft-deleted lake is restorable, so it keeps its claim.
 */
export const findCollidingPrefixLakes = async (
  { dataLakes }: PrefixCollisionAdapters,
  rawPrefix: string | undefined | null,
  scope: { createdByUserId: string; organizationId?: string; excludeLakeId?: string }
): Promise<PrefixScopeLake[]> => {
  // Normalized only to decide whether a usable prefix was supplied; overlap itself is
  // tagPrefixesOverlap's job, shared with the wizard so the two cannot drift.
  if (!normalizeTagPrefix(rawPrefix)) return [];

  const scopeArms: Record<string, unknown>[] = [{ createdByUserId: scope.createdByUserId }];
  if (scope.organizationId) scopeArms.push({ organizationId: scope.organizationId });

  const candidates = (await dataLakes.find({ $or: scopeArms })) as PrefixScopeLake[];
  return candidates.filter(lake => {
    if (scope.excludeLakeId && lake.id === scope.excludeLakeId) return false;
    return tagPrefixesOverlap(rawPrefix, lake.fileTagPrefix);
  });
};

/**
 * Warns when a lake about to lose files shares its prefix with another lake in scope, naming the
 * lakes involved. Prefix collisions predate the create-time guard, so rows that already collide
 * still exist, and this fires at the one moment anyone can act on it: prefix-tagged files that
 * the other lake also holds are about to be soft-deleted or purged. Best-effort - a failed lookup
 * must never block the teardown.
 */
export const warnOnPrefixCollision = async (
  { dataLakes }: PrefixCollisionAdapters,
  lake: Pick<IDataLakeDocument, 'id' | 'name' | 'fileTagPrefix' | 'createdByUserId' | 'organizationId'>,
  logger?: { warn: (msg: string, ...args: unknown[]) => void }
): Promise<void> => {
  if (!logger) return;
  try {
    const clashes = await findCollidingPrefixLakes({ dataLakes }, lake.fileTagPrefix, {
      createdByUserId: lake.createdByUserId,
      organizationId: lake.organizationId,
      excludeLakeId: lake.id,
    });
    if (clashes.length === 0) return;
    logger.warn(
      `[dataLakes] tearing down "${lake.name}" whose tag prefix ${lake.fileTagPrefix} overlaps ${clashes
        .map(l => `"${l.name}" (${l.fileTagPrefix})`)
        .join(', ')}; prefix-tagged files shared with those lakes are included`
    );
  } catch (err) {
    logger.warn(`[dataLakes] could not check tag-prefix overlap for "${lake.name}"`, err);
  }
};

/**
 * True when a prefix would collide with a STATIC registry lake's prefix. The registry's prefix arm
 * is an intentional ownership bypass and its lakes have no Mongo rows, so the query above cannot
 * see them - the same blind spot disambiguateSlug covers for reserved meta-tags.
 */
export const collidesWithRegistryPrefix = (rawPrefix: string | undefined | null): boolean =>
  DATA_LAKES.some(lake => tagPrefixesOverlap(rawPrefix, lake.fileTagPrefix));
