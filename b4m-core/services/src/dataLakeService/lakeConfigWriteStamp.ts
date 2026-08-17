import type { ManageActor } from './manageRule';

/**
 * The actor half of every lake CONFIG write: spread this into the update so the lake records WHO
 * changed it (see IDataLake.lastUpdatedByUserId).
 *
 * One helper rather than an inline field at each call site so the "resolved from the authenticated
 * actor, never from the request body" rule has a single home - and so the per-change audit event
 * can hang off the same seam instead of a second set of call sites drifting from this one.
 *
 * A blank actor id yields NO key at all rather than an empty string: a system/synthetic caller has
 * no identity to record, and a stored '' would read downstream as "a real principal whose id was
 * lost" rather than "not attributed". Omitting the key also leaves any prior stamp intact, which is
 * the honest outcome - an unattributable write should not erase the last write that WAS attributed.
 *
 * Attributes the WRITE, not a proven change: a caller whose payload sets every field to the value
 * it already held still moves the stamp. Each call site decides whether that write happens at all
 * (setLakeVisibility returns early on a no-op; updateDataLake does not diff its params), so a
 * same-value PUT does record its author here. Distinguishing a real change from a re-write needs a
 * before/after comparison, which is the config-change event's job, not this stamp's.
 */
export function lakeConfigWriteStamp(actor: Pick<ManageActor, 'userId'>): { lastUpdatedByUserId?: string } {
  return actor.userId ? { lastUpdatedByUserId: actor.userId } : {};
}
