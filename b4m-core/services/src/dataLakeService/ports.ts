import type { DataLakeMembershipScope } from '@bike4mind/common';

/** What a lifecycle sweep hands the index: the scope it ran on, and the member ids it resolved. */
export interface RetrievalIndexRemoval {
  scope: DataLakeMembershipScope;
  fabFileIds: string[];
}

/**
 * Optional retrieval/search index port. Products whose vectors live in the chunk store have no
 * separate index and omit it; `undefined` is the only case in this repo today.
 *
 * Keyed on lake MEMBERSHIP, never on the meta-tag alone. A file belongs to a lake on the exact
 * `datalake:` tag OR on a `fileTagPrefix` match against a file the lake's creator owns (see
 * buildDataLakeMembershipFilter in @bike4mind/database), and the lifecycle sweeps act on that
 * whole set - so a tag-keyed removal would strand a prefix-only member's entry pointing at a file
 * the phase-2 purge just hard-deleted. `fabFileIds` is passed rather than derived so an
 * implementer never has to rebuild that predicate against index metadata that may not carry the
 * owner or the tag array; the ids are exactly what the accompanying sweep resolved.
 *
 * Removal only - re-populating on unarchive/restore is the implementer's job, and the lifecycle
 * services do not call back in.
 */
export interface RetrievalIndexPort {
  removeForDataLake(input: RetrievalIndexRemoval): Promise<void>;
}

/**
 * Archive and phase-1 delete: a failure is logged, not fatal. Both are reversible, so a stale
 * entry is tolerated rather than blocking the transition.
 *
 * Ids resolve lazily and inside the try, so a door with no index wired pays no query, and a
 * lookup failure cannot abort an op that is contractually best-effort.
 */
export async function bestEffortIndexRemove(
  retrievalIndex: RetrievalIndexPort | undefined,
  scope: DataLakeMembershipScope,
  resolveFabFileIds: () => Promise<string[]>,
  logger?: { warn: (msg: string, ...args: unknown[]) => void }
): Promise<void> {
  if (!retrievalIndex) return;
  try {
    await retrievalIndex.removeForDataLake({ scope, fabFileIds: await resolveFabFileIds() });
  } catch (error) {
    logger?.warn(`Best-effort index removal failed for ${scope.datalakeTag}:`, error);
  }
}

/**
 * Phase-2 purge: propagates. An entry stranded here is permanent - the file it points at is about
 * to be hard-deleted, so no later run can reconcile it. Call it BEFORE anything destructive, so a
 * throw leaves zero progress and the cleanup queue's retry re-runs the sweep intact. The cost is
 * that a persistently failing index wedges the lake in 'deleted', which beats half-purged.
 */
export async function strictIndexRemove(
  retrievalIndex: RetrievalIndexPort | undefined,
  input: RetrievalIndexRemoval
): Promise<void> {
  if (!retrievalIndex) return;
  await retrievalIndex.removeForDataLake(input);
}
