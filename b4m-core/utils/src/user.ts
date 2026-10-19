import {
  IUserDocument,
  IOrganizationDocument,
  DEFAULT_STORAGE_LIMIT_MB,
  DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB,
  StorageLimitError,
  storageLimitToBytes,
} from '@bike4mind/common';

export const checkStorageLimit = async (user: IUserDocument, fileSize: number) => {
  const storageLimit = storageLimitToBytes(user.storageLimit ?? DEFAULT_STORAGE_LIMIT_MB);
  const currentStorageSize = user.currentStorageSize ?? 0;
  if (fileSize + currentStorageSize > storageLimit) {
    throw new StorageLimitError('File size exceeds storage limit', {
      errorCode: 'storage_limit_exceeded',
      // Clamped: a drifted counter or a negative stored limit must not put a value on the wire
      // that StorageLimitErrorInfoSchema (nonnegative) rejects.
      used_bytes: Math.max(0, currentStorageSize),
      limit_bytes: Math.max(0, storageLimit),
      requested_bytes: fileSize,
      owner: 'user',
    });
  }
};

/** Cumulative: every file the org owns (FabFile.organizationId) counts, whoever uploaded it. */
export const checkOrganizationStorageLimit = async (organization: IOrganizationDocument, fileSize: number) => {
  const storageLimit = storageLimitToBytes(organization.storageLimit ?? DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB);
  const currentStorageSize = organization.currentStorageSize ?? 0;
  if (fileSize + currentStorageSize > storageLimit) {
    throw new StorageLimitError('Organization storage limit exceeded', {
      errorCode: 'org_storage_limit_exceeded',
      used_bytes: Math.max(0, currentStorageSize),
      limit_bytes: Math.max(0, storageLimit),
      requested_bytes: fileSize,
      owner: 'org',
    });
  }
};

/**
 * The quota gate for bytes that will be billed to their owner (see storageOwnerOf in
 * @bike4mind/common): the org named by `organizationId` when set, else `user`. Pass the org the new
 * row will be STAMPED with (pickOwnerOrganizationId over the lakes it is written into), never the
 * user's selected org - that is a display preference and would gate personal files on the org's pool.
 */
export const checkStorageLimitForOwner = async (
  owner: { user: IUserDocument; organizationId?: string },
  bytes: number,
  getOrganization?: (id: string) => Promise<IOrganizationDocument | null>
) => {
  if (!owner.organizationId) return checkStorageLimit(owner.user, bytes);
  if (!getOrganization) {
    throw new Error('checkStorageLimitForOwner: an org-owned file needs getOrganization to check the org quota');
  }
  const organization = await getOrganization(owner.organizationId);
  // A deleted org keeps its lakes stamped and syncing, so refuse as a quota block with no
  // headroom: ingest then skips the file through its quota path instead of retrying to the DLQ.
  if (!organization) {
    throw new StorageLimitError('Organization not found', {
      errorCode: 'org_storage_limit_exceeded',
      used_bytes: 0,
      limit_bytes: 0,
      requested_bytes: bytes,
      owner: 'org',
    });
  }
  await checkOrganizationStorageLimit(organization, bytes);
};
