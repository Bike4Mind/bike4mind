/**
 * The one definition of whether a FabFile's `fileSize` is counted in its owner's
 * `currentStorageSize`. Every refund/re-charge site goes through `chargedBytes`, and the recalc truth
 * (FabFileRepository.sumFileSizeByUserId) matches `STORAGE_CHARGED_FILTER`.
 * Must stay in sync: `isStorageCharged` and `STORAGE_CHARGED_FILTER` encode the same rule.
 *
 * Charged = stamped by a charge (apps/client/server/s3/storageCharge.ts; a notebook import can stamp
 * a still-`pending` row), or a legacy `complete` row from before every charge stamped - back then
 * the ObjectCreated handler charged every upload it marked `complete`. After the cutoff an unstamped
 * `complete` row (marked uploaded before its event, or a self-host row) was never charged.
 */

// ponytail: first prod release carrying the stamp was prod-2026-10-07-b (08:50Z); rounded up a day
// on purpose - too late only refunds a few already-stamped-era rows, too early would skip real refunds.
export const STORAGE_CHARGE_STAMP_CUTOFF = new Date('2026-10-08T00:00:00Z');

/**
 * Mongo form of `isStorageCharged`. Has a top-level `$or`: spread it into a query only when that
 * query has no `$or` of its own, otherwise combine with `$and`.
 */
export const STORAGE_CHARGED_FILTER = {
  $or: [{ storageChargedAt: { $ne: null } }, { status: 'complete', createdAt: { $lt: STORAGE_CHARGE_STAMP_CUTOFF } }],
};

export interface StorageChargeFields {
  storageChargedAt?: Date | string | null;
  status?: string | null;
  createdAt?: Date | string | null;
}

export const isStorageCharged = (row: StorageChargeFields): boolean => {
  if (row.storageChargedAt != null) return true;
  if (row.status !== 'complete' || row.createdAt == null) return false;
  return new Date(row.createdAt).getTime() < STORAGE_CHARGE_STAMP_CUTOFF.getTime();
};

/** The bytes a refund should give back (or a restore re-charge) for this row: 0 if it was never charged. */
export const chargedBytes = (row: StorageChargeFields & { fileSize?: number | null }): number =>
  isStorageCharged(row) ? (row.fileSize ?? 0) : 0;
