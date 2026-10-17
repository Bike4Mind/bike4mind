/**
 * Who a FabFile's charged bytes are billed to: the owning org when the row carries
 * `organizationId` (stamped from the org lake it was created into, see pickOwnerOrganizationId in
 * b4m-core/services/src/fabFileService/resolveOwnerOrganization.ts), else the uploader. Every charge,
 * refund and quota check resolves the payer through `storageOwnerOf`, and the recalc truths split
 * the same way (FabFileRepository.sumFileSizeByUserId counts only PERSONAL_STORAGE_FILTER rows,
 * sumFileSizeByOrganizationId the org's), so a counter and its truth always agree on the row set.
 */
export type StorageOwner = { type: 'user'; id: string } | { type: 'org'; id: string };

export type StorageOwnerFields = { userId: string; organizationId?: string | null };

export const storageOwnerOf = (row: StorageOwnerFields): StorageOwner =>
  row.organizationId ? { type: 'org', id: row.organizationId } : { type: 'user', id: row.userId };

/**
 * Mongo filter for rows billed to their uploader: the personal arm of `storageOwnerOf`, which treats
 * any falsy organizationId as personal. `null` also matches a missing field; '' is listed so an
 * empty-string stamp is counted in the same truth it is charged to.
 */
export const PERSONAL_STORAGE_FILTER = { organizationId: { $in: [null, ''] } };

/** Sums signed byte deltas per owner, dropping owners whose total is 0. */
export const sumStorageDeltaByOwner = (
  deltas: ReadonlyArray<{ owner: StorageOwner; bytes: number }>
): Array<{ owner: StorageOwner; bytes: number }> => {
  const totals = new Map<string, { owner: StorageOwner; bytes: number }>();
  for (const { owner, bytes } of deltas) {
    if (!bytes) continue;
    const key = `${owner.type}:${owner.id}`;
    const entry = totals.get(key) ?? { owner, bytes: 0 };
    entry.bytes += bytes;
    totals.set(key, entry);
  }
  return [...totals.values()].filter(entry => entry.bytes !== 0);
};
