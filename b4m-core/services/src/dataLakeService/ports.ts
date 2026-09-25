import type {
  DataLakeMembershipScope,
  DataLakeSweptFile,
  IFabFileChunkRepository,
  IUserRepository,
} from '@bike4mind/common';

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
 * Wire it at every door or not at all - archiveDataLake, deleteDataLake, cleanupDeletedDataLake and
 * purgeDataLakeDocument each take it separately, and a door left unwired silently keeps the old
 * behavior. The first three act on a whole lake; purgeDataLakeDocument passes a single member id,
 * which the contract above already allows (`fabFileIds` is the removal set and the whole of it).
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
 * Ids resolve lazily and inside a try, so a door with no index wired pays no query, and a lookup
 * failure cannot abort an op that is contractually best-effort.
 *
 * Clears `retrievalIndexConfirmedModel` for every resolved file (via `fabFileChunks`, when wired)
 * BEFORE attempting the removal, not after - the reverse order left a gap where the OpenSearch
 * delete succeeds but the clear then fails (DocumentDB failover, timeout on a large `$in`): the
 * confirm would never be retried (unarchive has no re-index path) and the file would end up
 * permanently stamped-ready, confirmed, and absent from the index - exactly what this port exists
 * to prevent. If the clear itself fails, the removal is SKIPPED, not run anyway - running it would
 * over-claim (index doc gone, confirm still set), the one outcome `annResidentFabFileIds`'s safe
 * bias must never see; skipping instead leaves the index document and the confirm both untouched,
 * which is exactly the state the file was already in - no worse than not having attempted the
 * removal at all, and nothing is silently promised to self-heal on its own. Each step gets its own
 * try/catch and log line so a clear failure is never misreported as an index-removal failure (or
 * vice versa) to whoever is on call.
 * Kept here rather than at each call site so a door wiring `retrievalIndex` cannot forget to wire
 * this half too.
 */
export async function bestEffortIndexRemove(
  retrievalIndex: RetrievalIndexPort | undefined,
  scope: DataLakeMembershipScope,
  resolveFabFileIds: () => Promise<string[]>,
  logger?: { warn: (msg: string, ...args: unknown[]) => void },
  fabFileChunks?: Pick<IFabFileChunkRepository, 'clearRetrievalIndexConfirmedByFabFileIds'>
): Promise<void> {
  if (!retrievalIndex) return;
  let fabFileIds: string[];
  try {
    fabFileIds = await resolveFabFileIds();
  } catch (error) {
    logger?.warn(`Best-effort index removal failed for ${scope.datalakeTag}:`, error);
    return;
  }
  try {
    await fabFileChunks?.clearRetrievalIndexConfirmedByFabFileIds(fabFileIds);
  } catch (error) {
    logger?.warn(
      `Failed to clear the retrieval-index confirm before best-effort removal for ${scope.datalakeTag}:`,
      error
    );
    return;
  }
  try {
    await retrievalIndex.removeForDataLake({ scope, fabFileIds });
  } catch (error) {
    logger?.warn(`Best-effort index removal failed for ${scope.datalakeTag}:`, error);
  }
}

/**
 * Phase-2 purge: propagates. An entry stranded here is permanent - the file it points at is about
 * to be hard-deleted, so no later run can reconcile it. Call it BEFORE anything destructive, so a
 * throw leaves zero progress and the cleanup queue's retry re-runs the sweep intact. The cost is
 * that a persistently failing index wedges the lake in 'purging', which beats half-purged.
 *
 * "Zero progress" covers the THROW only, and is not an absolute. If removal succeeds and a later
 * step then fails terminally, the lake stays 'purging' with its entries already dropped, and this
 * port has no add operation to put them back. That much is progress no retry undoes; re-population
 * is the implementer's job. Note that restore is NOT the way out of this state since #1744 -
 * `restoreDeletedDataLake` refuses a purge-accepted lake outright, so recovery is a DLQ replay of
 * the sweep (`api/admin/dlq/replay.ts`), which finishes the purge rather than reversing it.
 *
 * This is the canonical description of both postures. Call sites point here rather than restating.
 *
 * Also clears `retrievalIndexConfirmedModel` for `input.fabFileIds` (via `fabFileChunks`, when
 * wired), BEFORE the removal itself - the same crash-window reasoning as `bestEffortIndexRemove`
 * above for WHY clear-before-remove. The failure posture differs, though: a clear failure here is
 * logged AND rethrown, never swallowed. The clear runs before anything destructive, so a throw
 * here is genuinely zero progress, matching this function's own "zero progress on a throw"
 * contract above. Swallowing it and running the removal anyway would over-claim (index doc gone,
 * confirm still set) with no retry path to fix it - unarchive/re-vectorize is the only way a
 * confirm gets set again, and this file is not going through either - which is the exact
 * stranding this port exists to prevent, so `bestEffortIndexRemove`'s "skip on clear failure" and
 * this function's "rethrow on clear failure" are the same over-claim-avoidance choice expressed in
 * each posture's own vocabulary (skip vs. abort).
 */
export async function strictIndexRemove(
  retrievalIndex: RetrievalIndexPort | undefined,
  input: RetrievalIndexRemoval,
  fabFileChunks?: Pick<IFabFileChunkRepository, 'clearRetrievalIndexConfirmedByFabFileIds'>,
  logger?: { warn: (msg: string, ...args: unknown[]) => void }
): Promise<void> {
  if (!retrievalIndex) return;
  try {
    await fabFileChunks?.clearRetrievalIndexConfirmedByFabFileIds(input.fabFileIds);
  } catch (error) {
    logger?.warn(
      `Failed to clear the retrieval-index confirm before strict removal for ${input.scope.datalakeTag}:`,
      error
    );
    throw error;
  }
  await retrievalIndex.removeForDataLake(input);
}

/**
 * Sums `swept[].fileSize` per `userId` and signs the total by `sign` (-1 on soft delete, since
 * those files leave the owner's counted set; +1 on restore, since they re-enter it). Grouped by
 * owner, never collapsed to one id, because lake membership carries no ownership conjunct on the
 * meta-tag arm - a contributor's own file is a full member of someone else's lake and is billed to
 * its own uploader (see `DataLakeSweptFile`). Zero-size files are dropped rather than emitting a
 * no-op delta.
 */
export function groupStorageDeltaByOwner(swept: DataLakeSweptFile[], sign: 1 | -1): Map<string, number> {
  const totals = new Map<string, number>();
  for (const file of swept) {
    const size = file.fileSize;
    if (!size) continue;
    totals.set(file.userId, (totals.get(file.userId) ?? 0) + sign * size);
  }
  return totals;
}

/**
 * Apply a per-owner storage delta after a delete/restore sweep - one atomic
 * `incrementCurrentStorage` per owner rather than a single aggregate write, since a sweep can
 * span several owners' files (see `groupStorageDeltaByOwner`). Best-effort like
 * `bestEffortSetDriveConnectionEnabled` below and for the same reason: failing an
 * otherwise-successful lifecycle transition over a quota-accounting hiccup would be worse than a
 * counter briefly out of sync, and the admin recalculate-storage endpoint
 * (`recalculateUserStorage`) is the existing backstop for exactly that drift.
 *
 * `users` takes `| undefined` even though the service-level adapter type declares it required -
 * same split as `recordLakeConfigChange`'s `lakeConfigChangeEvents` (see its own
 * `NonNullable<...>` wrapping on each service's adapter type): required at the real API door so a
 * route cannot forget it, tolerated here so a caller with no reason to exercise storage accounting
 * (a script, a test) simply gets no adjustment rather than a crash.
 */
export async function bestEffortAdjustOwnerStorage(
  users: Pick<IUserRepository, 'incrementCurrentStorage'> | undefined,
  deltasByOwner: Map<string, number>,
  logger?: { warn?: (msg: string, ...args: unknown[]) => void }
): Promise<void> {
  if (!users) return;
  for (const [userId, deltaBytes] of deltasByOwner) {
    try {
      await users.incrementCurrentStorage(userId, deltaBytes);
    } catch (error) {
      logger?.warn?.(`Failed to adjust storage for user ${userId} after a data lake lifecycle sweep:`, error);
    }
  }
}

/**
 * Optional port: flip `enabled` on whatever Drive connection feeds a lake - disable on
 * archive/delete, re-enable on unarchive/restore. Injected because the connection lookup + write
 * lives in the app layer (see disableDriveConnectionForLake/enableDriveConnectionForLake), same
 * reason `releaseDriveConnection` is injected into cleanupDeletedDataLake. Absent -> a host
 * without the Drive integration is unaffected.
 */
export type DriveConnectionEnablePort = (args: { dataLakeId: string }) => Promise<void>;

/**
 * Archive/delete/unarchive/restore: a failure here is logged, not fatal - failing a whole lifecycle
 * transition over a Drive hiccup would be a worse outcome than a connection briefly out of sync with
 * its lake. The two directions are swallowed for DIFFERENT reasons, and neither is "the ingest guard
 * covers it":
 *
 * - A lost DISABLE is genuinely backstopped: the ingest-level status guard (driveLakeIngest.ts)
 *   refuses to sync a lake that is not draft/active, so the poll keeps enqueueing work that is always
 *   dropped. Wasteful, never incorrect.
 * - A lost ENABLE has no backstop - `findDueForPoll` is the only reader that ACTS on the flag (the
 *   enabled-only finders and the per-lake GET read it too, but none of them resumes a poll) - so it
 *   is swallowed only because it is REPAIRABLE: the reconnect door re-stamps `enabled: true`
 *   (OrgGoogleDriveConnection.updateCredential), which is where a user goes when sync looks broken.
 *   The GET does report `enabled` truthfully, but no UI reads it - the connection chip renders from
 *   `status` alone - so this state is inspectable over the API, not in the product. Do not remove
 *   that re-stamp without making this direction fatal instead.
 */
export async function bestEffortSetDriveConnectionEnabled(
  port: DriveConnectionEnablePort | undefined,
  dataLakeId: string,
  // Optional `warn` (not the required shape bestEffortIndexRemove takes): unarchive/restore only
  // inherit LakeConfigAuditAdapters's LakeConfigAuditLogger, which declares it optional.
  logger?: { warn?: (msg: string, ...args: unknown[]) => void }
): Promise<void> {
  if (!port) return;
  try {
    await port({ dataLakeId });
  } catch (error) {
    logger?.warn?.(`Failed to update Drive connection enabled state for lake ${dataLakeId}:`, error);
  }
}
