import { datalakeTagsFrom } from './getDataLakePrompts';

/**
 * Fair-share ordering of a multi-lake file scope.
 *
 * The retrieval budgets (`maxChunks`, and the chunk pages inside each file group) are spent
 * SEQUENTIALLY down the scoped file order. That order used to be whatever `fabfiles.search`
 * returned - one global `fileName asc` sort over the union of every scoped lake - so the budget
 * was consumed by whichever lake happened to sort first, and a lake whose files landed past the
 * cut contributed nothing at all. Adding a small lake to a session already holding two large ones
 * then changed the retrieved passages not at all, while telemetry still reported three lakes
 * searched.
 *
 * Interleaving by lake makes the spend proportional instead of positional: every lake's head of
 * list lands inside the first file group, so each one reaches the ranker before any single lake
 * can exhaust the budget. It reorders, never filters - the same files are in scope either way.
 *
 * Fairness is at FILE granularity, which is the granularity the chunk budget is spent at across
 * groups. WITHIN one group `findVectorsByFabFileIds` still pages by chunkId, so a budget small
 * enough to run out inside a single group is still drawn in chunkId order and can under-serve a
 * lake in that last group. Bounded by one group (default 200 files) and only reachable when
 * `maxChunks` is below a single group's chunk count; making that fair too means querying chunks
 * per lake rather than per group.
 */

/** One bucket's worth of lake identity: whichever of the two arms can reverse a file's tags to it. */
export interface LakeOrderScope {
  /**
   * Bucket identity. Two scopes sharing a key are the same lake (a meta-tag and a membership arm
   * for one lake merge rather than splitting its files across two buckets).
   */
  key: string;
  datalakeTag?: string;
  /**
   * Content-tag prefix arm, for a registry lake whose files carry no `datalake:<slug>` meta-tag -
   * see attributeAccessedLakes, which reverses attribution the same two ways.
   */
  fileTagPrefix?: string;
}

/**
 * The scope args semanticDataLakeSearch already receives, as the ordering wants them. `null` is
 * admitted on the membership arm because `DataLakeMembershipScope.fileTagPrefix` is nullable (it
 * mirrors the persisted document); it is normalized to undefined below.
 */
export interface LakeOrderScopeSources {
  dataLakeTags: string[];
  dataLakeTagPrefixes: string[];
  lakeMemberships: { datalakeTag?: string | null; fileTagPrefix?: string | null }[];
}

/**
 * Collapse the caller's three scope arms into one bucket per lake. A lake reachable by both its
 * meta-tag and a membership arm must yield ONE bucket, or its files would be split in two and it
 * would draw a double share of the budget.
 */
export function lakeOrderScopes(sources: LakeOrderScopeSources): LakeOrderScope[] {
  const byKey = new Map<string, LakeOrderScope>();
  const upsert = (key: string, scope: Omit<LakeOrderScope, 'key'>) => {
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { key, ...scope });
      return;
    }
    existing.datalakeTag ??= scope.datalakeTag;
    existing.fileTagPrefix ??= scope.fileTagPrefix;
  };

  for (const tag of sources.dataLakeTags) upsert(tag, { datalakeTag: tag });
  for (const membership of sources.lakeMemberships) {
    const datalakeTag = membership.datalakeTag || undefined;
    const fileTagPrefix = membership.fileTagPrefix || undefined;
    // Keyed on the meta-tag so it merges with the dataLakeTags arm above; a membership carrying
    // only a prefix is its own lake and keys on that instead.
    const key = datalakeTag ?? (fileTagPrefix ? `prefix:${fileTagPrefix}` : undefined);
    if (!key) continue;
    upsert(key, { datalakeTag, fileTagPrefix });
  }
  // Namespaced so a registry prefix can never collide with a `datalake:` meta-tag key.
  for (const prefix of sources.dataLakeTagPrefixes) upsert(`prefix:${prefix}`, { fileTagPrefix: prefix });

  return [...byKey.values()];
}

/** Bucket key for files attributable to no lake - the caller's own and shared files, which
 *  `collectScopedFiles` admits via `includeShared` and which must not be starved either. */
export const UNATTRIBUTED_LAKE_KEY = '';

/**
 * The lake bucket a file is charged to. A file carrying several lakes' tags is charged to its
 * FIRST matching scope (scope order, which is the caller's own lake order) so it is counted and
 * emitted exactly once - double-emitting it would both duplicate a chunk query and inflate the
 * lake it appears under twice.
 */
function bucketFor(fileTags: string[], scopes: LakeOrderScope[]): string {
  const metaTags = new Set(datalakeTagsFrom(fileTags));
  for (const scope of scopes) {
    if (scope.datalakeTag && metaTags.has(scope.datalakeTag)) return scope.key;
    if (scope.fileTagPrefix && fileTags.some(tag => typeof tag === 'string' && tag.startsWith(scope.fileTagPrefix!)))
      return scope.key;
  }
  return UNATTRIBUTED_LAKE_KEY;
}

export interface LakeFairOrderResult<T> {
  /** The same items, reordered round-robin across lake buckets. */
  ordered: T[];
  /** Scoped file count per bucket key, including `UNATTRIBUTED_LAKE_KEY` when non-empty. */
  filesByLake: Record<string, number>;
}

/**
 * Round-robin the scoped files across their lakes, preserving each lake's own relative order.
 *
 * Buckets are emitted in `scopes` order (then unattributed last within each round), so the result
 * is a pure function of the inputs - a budget that truncates the walk truncates it at the same
 * place on every identical call.
 */
export function orderFilesFairlyAcrossLakes<T>(
  files: T[],
  scopes: LakeOrderScope[],
  fileTagsOf: (file: T) => string[]
): LakeFairOrderResult<T> {
  const buckets = new Map<string, T[]>();
  // Seeded in scope order so the round-robin emits lakes in a stable order regardless of which
  // lake the first scoped file happened to belong to.
  for (const scope of scopes) buckets.set(scope.key, []);

  for (const file of files) {
    const key = bucketFor(fileTagsOf(file), scopes);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(file);
    else buckets.set(key, [file]);
  }

  const filesByLake: Record<string, number> = {};
  const nonEmpty: T[][] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.length === 0) continue;
    filesByLake[key] = bucket.length;
    nonEmpty.push(bucket);
  }

  // One pass per round rather than splicing: O(files), and a drained bucket simply contributes
  // nothing to later rounds instead of needing removal.
  const ordered: T[] = [];
  const longest = nonEmpty.reduce((max, bucket) => Math.max(max, bucket.length), 0);
  for (let round = 0; round < longest; round++) {
    for (const bucket of nonEmpty) {
      const file = bucket[round];
      if (file !== undefined) ordered.push(file);
    }
  }

  return { ordered, filesByLake };
}
