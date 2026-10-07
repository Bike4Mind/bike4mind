import {
  DATA_LAKES,
  normalizeTagPrefix,
  tagPrefixesOverlap,
  type IDataLakeDocument,
  MAX_TAG_PREFIX_SUFFIX_ATTEMPTS,
  withTagPrefixSuffix,
  type IDataLakeRepository,
} from '@bike4mind/common';

/**
 * `additionalInfo.code` on the BadRequestError createDataLake throws for a taken or reserved tag
 * prefix, so a caller that can mint another prefix (create_data_lake) keys off it, not the message.
 */
export const TAG_PREFIX_UNAVAILABLE_CODE = 'TAG_PREFIX_UNAVAILABLE';

type PrefixScopeLake = Pick<IDataLakeDocument, 'id' | 'name' | 'fileTagPrefix' | 'createdByUserId'>;

interface PrefixCollisionAdapters {
  dataLakes: Pick<IDataLakeRepository, 'find'>;
}

interface PrefixScope {
  createdByUserId: string;
  organizationId?: string;
}

const prefixScopeArms = (scope: PrefixScope): Record<string, unknown>[] => {
  const arms: Record<string, unknown>[] = [{ createdByUserId: scope.createdByUserId }];
  if (scope.organizationId) arms.push({ organizationId: scope.organizationId });
  return arms;
};

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
  scope: PrefixScope & { excludeLakeId?: string }
): Promise<PrefixScopeLake[]> => {
  // Normalized only to decide whether a usable prefix was supplied; overlap itself is
  // tagPrefixesOverlap's job, shared with the wizard so the two cannot drift.
  if (!normalizeTagPrefix(rawPrefix)) return [];

  const candidates = (await dataLakes.find({ $or: prefixScopeArms(scope) })) as PrefixScopeLake[];
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

/**
 * The first `withTagPrefixSuffix` candidate that createDataLake's prefix guard would accept for
 * this scope right now, so the wizard can offer it before create. Advisory only: a concurrent
 * create can still take it first, and create stays the authority. One scope query, then the
 * candidates are checked in memory. No status filter, same as findCollidingPrefixLakes: archived
 * and deleted lakes keep their claim until purged. On exhaustion returns the base unchanged, so
 * create's own error stands.
 */
export const previewDataLakeTagPrefix = async (
  { dataLakes }: PrefixCollisionAdapters,
  basePrefix: string,
  scope: PrefixScope
): Promise<string> => {
  const held = ((await dataLakes.find({ $or: prefixScopeArms(scope) })) as PrefixScopeLake[]).map(
    lake => lake.fileTagPrefix
  );
  for (let attempt = 0; attempt < MAX_TAG_PREFIX_SUFFIX_ATTEMPTS; attempt++) {
    const candidate = withTagPrefixSuffix(basePrefix, attempt);
    if (collidesWithRegistryPrefix(candidate)) continue;
    if (!held.some(prefix => tagPrefixesOverlap(candidate, prefix))) return candidate;
  }
  return basePrefix;
};
