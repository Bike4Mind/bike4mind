/**
 * The one definition of whether a FabFile's `fileSize` is counted in its owner's
 * `currentStorageSize`. The S3 charge claim (apps/client/server/s3/storageCharge.ts), the content
 * rewrite commit and its quota gate (b4m-core/services/src/fabFileService/rewriteStorage.ts) go
 * through `chargedBytes`, always on a lean row: a hydrated FabFile reports an absent `status` as its
 * 'pending' default. `STORAGE_CHARGED_FILTER` is the Mongo form, for readers that query charged rows.
 * Must stay in sync: `isStorageCharged` and `STORAGE_CHARGED_FILTER` encode the same rule.
 *
 * Charged = stamped by a charge (apps/client/server/s3/storageCharge.ts; a notebook import can stamp
 * a still-`pending` row), or a legacy non-`pending` row from before the stamping release (an absent
 * `status` predates the field and counts as complete, as in findByContentHashes). That legacy
 * arm is the HOSTED prod history: there the ObjectCreated handler charged every upload it marked
 * `complete`. A self-host install's webhook marked rows `complete` without charging them, so its
 * pre-cutoff rows read as charged here - they over-refund (the counter clamps at 0) and
 * `sumFileSizeByUserId` counts them; backfill `storageChargedAt` on such an install to make the rule
 * exact again. After the cutoff an unstamped `complete` row (marked uploaded before its event, or a
 * self-host row) was never charged.
 */

// ponytail: first HOSTED prod release carrying the stamp was prod-2026-10-07-b (08:50Z); rounded up
// a day on purpose - too late only refunds a few already-stamped-era rows, too early would skip real
// refunds. A HOSTED deployment that picked the stamp up after the cutoff is the "too early" case:
// its charged-but-unstamped rows would read as uncharged.
export const STORAGE_CHARGE_STAMP_CUTOFF = new Date('2026-10-08T00:00:00Z');

/**
 * Mongo form of `isStorageCharged`. Has a top-level `$or`: spread it into a query only when that
 * query has no `$or` of its own, otherwise combine with `$and`.
 */
export const STORAGE_CHARGED_FILTER = {
  $or: [
    { storageChargedAt: { $ne: null } },
    { status: { $ne: 'pending' }, createdAt: { $lt: STORAGE_CHARGE_STAMP_CUTOFF } },
  ],
};

export interface StorageChargeFields {
  storageChargedAt?: Date | string | null;
  status?: string | null;
  createdAt?: Date | string | null;
}

export const isStorageCharged = (row: StorageChargeFields): boolean => {
  if (row.storageChargedAt != null) return true;
  if (row.status === 'pending' || row.createdAt == null) return false;
  return new Date(row.createdAt).getTime() < STORAGE_CHARGE_STAMP_CUTOFF.getTime();
};

/** The bytes a refund should give back (or a restore re-charge) for this row: 0 if it was never charged. */
export const chargedBytes = (row: StorageChargeFields & { fileSize?: number | null }): number =>
  isStorageCharged(row) ? (row.fileSize ?? 0) : 0;
