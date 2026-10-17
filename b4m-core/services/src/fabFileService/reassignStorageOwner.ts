import {
  chargedBytes,
  isDataLakeTagName,
  NotFoundError,
  storageOwnerOf,
  type IDataLakeRepository,
  type IFabFileDocument,
  type IFabFileRepository,
  type IOrganizationRepository,
  type IUserRepository,
  type StorageOwner,
} from '@bike4mind/common';
import { checkStorageLimitForOwner } from '@bike4mind/utils';
import { adjustOwnerStorage } from './ownerStorage';
import { pickOwnerOrganizationId } from './resolveOwnerOrganization';

/**
 * Keeps a file's storage owner in step with its lake membership after create. createFabFile stamps
 * `organizationId` from the org lakes the file is written into; when a later write adds or strips a
 * `datalake:` meta-tag, the owner is recomputed with the same rule (pickOwnerOrganizationId over the
 * lakes the file's meta-tags name, honoring `sourceLakeId` like the owner backfill) and the charged
 * bytes move with the stamp.
 *
 * Policy:
 * - A file that leaves every org lake goes back to its uploader (the stamp is unset), the same owner
 *   it would have had if it had been created outside any org lake.
 * - Only a JOIN is quota-gated (`assertStorageOwnerTransferFits`, before the tag write). A removal,
 *   including the lake-delete sweep, always lands its bytes on the new owner even past quota:
 *   refusing it would let a full pool pin a file to a lake it was taken out of. The owner is then
 *   blocked at their next upload, like any other over-quota state.
 * - Only `datalake:` meta-tags count, as in createFabFile's tag gate; prefix-arm content tags never
 *   move ownership.
 *
 * Call sites (every door that changes a live file's meta-tags): addFileToLake / removeFileFromLake
 * (b4m-core/services/src/dataLakeService/lakeMembership.ts, which every add/remove/toggle/ingest
 * path funnels through), updateFabFile's reconcileLakeTags join, and cleanupDeletedDataLake's
 * survivor sweep.
 */

export type StorageOwnerTransferDb = {
  fabFiles: Pick<IFabFileRepository, 'findById' | 'setOwnerOrganizationIfUnchanged'>;
  dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTags'>;
  users: Pick<IUserRepository, 'findById' | 'incrementCurrentStorage'>;
  organizations: Pick<IOrganizationRepository, 'findById' | 'incrementCurrentStorage'>;
};

type OwnerSourceFile = Pick<
  IFabFileDocument,
  'userId' | 'organizationId' | 'sourceLakeId' | 'fileSize' | 'storageChargedAt' | 'status' | 'createdAt'
>;

export type StorageOwnerTransfer = {
  from: StorageOwner;
  to: StorageOwner;
  /** The stamp `to` implies: undefined when the file goes back to its uploader. */
  nextOrganizationId: string | undefined;
  bytes: number;
};

const storedTagNames = (file: Pick<IFabFileDocument, 'tags'>): string[] =>
  (file.tags ?? []).map(tag => tag?.name).filter((name): name is string => typeof name === 'string');

/**
 * The owner change that giving `file` exactly the meta-tags in `tagNames` implies, or null when the
 * owner stays the same. Reads lakes only; writes nothing.
 */
export async function resolveStorageOwnerTransfer(
  file: OwnerSourceFile,
  tagNames: readonly string[],
  db: Pick<StorageOwnerTransferDb, 'dataLakes'>
): Promise<StorageOwnerTransfer | null> {
  const lakeTags = [...new Set(tagNames.filter(isDataLakeTagName))];
  const lakes = lakeTags.length ? await db.dataLakes.findByDatalakeTags(lakeTags) : [];
  const nextOrganizationId = pickOwnerOrganizationId(lakes, file.sourceLakeId || undefined);
  // storageOwnerOf treats any falsy stamp as personal, so '' and undefined are the same owner.
  if ((nextOrganizationId ?? '') === (file.organizationId || '')) return null;
  return {
    from: storageOwnerOf(file),
    to: storageOwnerOf({ userId: file.userId, organizationId: nextOrganizationId }),
    nextOrganizationId,
    bytes: chargedBytes(file),
  };
}

/**
 * The join gate: throws a StorageLimitError when giving `file` the meta-tags in `tagNames` would move
 * its charged bytes onto an owner with no room for them. Call it BEFORE the tag write, so a refused
 * join writes nothing even on a door that runs outside a transaction.
 */
export async function assertStorageOwnerTransferFits(
  file: OwnerSourceFile,
  tagNames: readonly string[],
  db: Pick<StorageOwnerTransferDb, 'dataLakes' | 'users' | 'organizations'>
): Promise<void> {
  const transfer = await resolveStorageOwnerTransfer(file, tagNames, db);
  if (!transfer || transfer.bytes <= 0) return;
  const uploader = await db.users.findById(file.userId);
  if (!uploader) throw new NotFoundError('File owner not found');
  await checkStorageLimitForOwner({ user: uploader, organizationId: transfer.nextOrganizationId }, transfer.bytes, id =>
    db.organizations.findById(id)
  );
}

// A lost compare-and-set means a concurrent charge, rewrite or reassign moved the row; re-reading
// settles it. Bounded so a hot row cannot spin a request forever.
const MAX_REASSIGN_ATTEMPTS = 3;

/**
 * Settles a live file's owner after its meta-tags changed: restamps `organizationId` from the tags
 * the file now carries and moves its charged bytes from the old owner's counter to the new one's.
 * Never quota-gated (see the policy above). Returns the transfer made, or null when the owner did
 * not change or the file is gone. The stamp write and the two counter moves are separate writes,
 * atomic only inside the caller's transaction; a crash between them drifts the counters until the
 * storage reconciliation runs.
 */
export async function reassignStorageOwner(
  fabFileId: string,
  db: StorageOwnerTransferDb
): Promise<StorageOwnerTransfer | null> {
  for (let attempt = 0; attempt < MAX_REASSIGN_ATTEMPTS; attempt++) {
    const file = await db.fabFiles.findById(fabFileId);
    if (!file) return null;
    const transfer = await resolveStorageOwnerTransfer(file, storedTagNames(file), db);
    if (!transfer) return null;
    if (!(await db.fabFiles.setOwnerOrganizationIfUnchanged(file.id, file, transfer.nextOrganizationId))) continue;
    await adjustOwnerStorage(db, transfer.from, -transfer.bytes);
    await adjustOwnerStorage(db, transfer.to, transfer.bytes);
    return transfer;
  }
  throw new Error(`reassignStorageOwner: file ${fabFileId} kept changing under the owner transfer`);
}
