import {
  IUserDocument,
  IOrganizationDocument,
  DEFAULT_STORAGE_LIMIT_MB,
  StorageLimitError,
  storageLimitToBytes,
} from '@bike4mind/common';
import { BadRequestError } from './errors';

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

// Per-file ceiling only: organizations track no cumulative storage usage.
export const checkOrganizationStorageLimit = async (organization: IOrganizationDocument, fileSize: number) => {
  const storageLimit = storageLimitToBytes(organization.storageLimit ?? DEFAULT_STORAGE_LIMIT_MB);
  if (fileSize > storageLimit) {
    throw new StorageLimitError('Organization storage limit exceeded', {
      errorCode: 'org_storage_limit_exceeded',
      used_bytes: 0,
      limit_bytes: Math.max(0, storageLimit),
      requested_bytes: fileSize,
      owner: 'org',
    });
  }
};

export const checkStorageLimitForFile = async (
  user: IUserDocument,
  fileSize: number,
  organizationId?: string,
  getOrganization?: (id: string) => Promise<IOrganizationDocument | null>
) => {
  if (organizationId && getOrganization) {
    const organization = await getOrganization(organizationId);
    if (!organization) {
      throw new BadRequestError('Organization not found');
    }
    await checkOrganizationStorageLimit(organization, fileSize);
  } else {
    // Fall back to user storage limit
    await checkStorageLimit(user, fileSize);
  }
};
