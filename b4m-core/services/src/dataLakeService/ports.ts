import type { DataLakeMembershipScope } from '@bike4mind/common';

/**
 * What a lifecycle sweep hands the index: the lake it ran on, and the member ids it resolved.
 *
 * `fabFileIds` is the removal set and the whole of it. `scope` says WHICH LAKE the sweep was for -
 * useful to an implementer that partitions by lake - and must never be used to narrow, widen or
 * second-guess the ids.
 */
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
 * owner or the tag array.
 *
 * DROP THE DOCUMENTS OUTRIGHT, not just from a per-lake view. Every caller is hiding or destroying
 * the files themselves, so a file left retrievable anywhere is the failure this port exists to
 * prevent. That is also why the ids can be a superset of what one transition flipped: archive and
 * phase-1 delete each skip files already in the target state, but the removal covers every member
 * the scope matches, so a re-run after a crash still converges.
 *
 * Wire it at all three doors or not at all - archiveDataLake, deleteDataLake, cleanupDeletedDataLake
 * each take it separately, and a door left unwired silently keeps the old behavior.
 *
 * Removal only: there is no add operation, so an implementer must re-populate through its own
 * ingest path after unarchive or restore. Those doors do not call back in.
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
