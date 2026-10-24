import {
  chargedBytes,
  ConflictError,
  DATA_LAKE_SLUG_UNRESOLVABLE_STATUSES,
  isDataLakeTagName,
  NotFoundError,
  storageOwnerOf,
  type IDataLakeDocument,
  type IDataLakeRepository,
  type IFabFileDocument,
  type IFabFileRepository,
  type IOrganizationRepository,
  type IUserRepository,
  type StorageOwner,
} from '@bike4mind/common';
import { checkStorageLimitForOwner } from '@bike4mind/utils';
import { storedTagNames } from '../tagService/bulkTagNames';
import { adjustOwnerStorage } from './ownerStorage';
import { pickOwnerOrganizationId } from './resolveOwnerOrganization';

/**
 * Keeps a file's storage owner (`organizationId` stamp + charged bytes) in step with its `datalake:`
 * meta-tags after create, using createFabFile's rule (pickOwnerOrganizationId, honoring sourceLakeId).
 * Only a join that changes the owner is quota-gated; a leave never is (a full pool must not pin a file
 * to a lake it left), so a leave can land bytes on a pool an owner-preserving join never checked.
 * A file in no org lake goes back to its uploader. Prefix-arm tags never count.
 * Callers: lakeMembership.ts add/remove, updateFabFile, cleanupDeletedDataLake.
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

/**
 * The owner change that giving `file` exactly the meta-tags in `tagNames` implies, or null when the
 * owner stays the same. Reads lakes only; writes nothing. `prefetchedLakes`, when given, must cover
 * every meta-tag in `tagNames` (a batch caller's one findByDatalakeTags) and replaces the query.
 */
export async function resolveStorageOwnerTransfer(
  file: OwnerSourceFile,
  tagNames: readonly string[],
  db: Pick<StorageOwnerTransferDb, 'dataLakes'>,
  prefetchedLakes?: readonly IDataLakeDocument[]
): Promise<StorageOwnerTransfer | null> {
  const lakeTags = [...new Set(tagNames.filter(isDataLakeTagName))];
  const found = !lakeTags.length
    ? []
    : prefetchedLakes
      ? prefetchedLakes.filter(lake => lakeTags.includes(lake.datalakeTag))
      : await db.dataLakes.findByDatalakeTags(lakeTags);
  // A deleted or purging lake no longer owns anything; a missing status is a legacy live lake.
  const lakes = found.filter(
    lake => !(DATA_LAKE_SLUG_UNRESOLVABLE_STATUSES as readonly string[]).includes(lake.status)
  );
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
 * join writes nothing even on a door that runs outside a transaction. Returns the transfer it graded,
 * or null when the owner would not change.
 */
export async function assertStorageOwnerTransferFits(
  file: OwnerSourceFile,
  tagNames: readonly string[],
  db: Pick<StorageOwnerTransferDb, 'dataLakes' | 'users' | 'organizations'>
): Promise<StorageOwnerTransfer | null> {
  const transfer = await resolveStorageOwnerTransfer(file, tagNames, db);
  if (!transfer || transfer.bytes <= 0) return transfer;
  const uploader = await db.users.findById(file.userId);
  if (!uploader) throw new NotFoundError('File owner not found');
  await checkStorageLimitForOwner({ user: uploader, organizationId: transfer.nextOrganizationId }, transfer.bytes, id =>
    db.organizations.findById(id)
  );
  return transfer;
}

// A lost compare-and-set means a concurrent charge, rewrite or reassign moved the row; re-reading
// settles it. Bounded so a hot row cannot spin a request forever.
const MAX_REASSIGN_ATTEMPTS = 3;

/**
 * Settles a live file's owner after its meta-tags changed: restamps `organizationId` from the tags
 * the file now carries and moves its charged bytes from the old owner's counter to the new one's.
 * Never quota-gated (see the policy above). Returns the transfer made, or null when the owner did
 * not change or the file is gone.
 *
 * The stamp write and the two counter moves are separate writes, atomic only inside the caller's
 * transaction; a crash between them drifts the counters until the storage reconciliation runs. The
 * stamp itself is NOT re-derived by that reconciliation (it recomputes counters FROM the stamp), so
 * every caller runs this unconditionally after its tag write rather than only when the write changed
 * something. Outside a transaction, only a retry that targets this file id again repairs a failed reassign (the
 * removal refusal restamps); a connector unpick's retry relists by lake tag and a toggle's retry flips the tag.
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
  throw new ConflictError(`File ${fabFileId} kept changing during the storage owner transfer; try again`);
}
