import { IUserDocument, IOrganizationDocument, DEFAULT_STORAGE_LIMIT_MB, storageLimitToBytes } from '@bike4mind/common';
import { BadRequestError } from './errors';

export const checkStorageLimit = async (user: IUserDocument, fileSize: number) => {
  const storageLimit = storageLimitToBytes(user.storageLimit ?? DEFAULT_STORAGE_LIMIT_MB);
  const currentStorageSize = user.currentStorageSize ?? 0;
  if (fileSize + currentStorageSize > storageLimit) throw new BadRequestError('File size exceeds storage limit');
};

// Per-file ceiling only: organizations track no cumulative storage usage.
export const checkOrganizationStorageLimit = async (organization: IOrganizationDocument, fileSize: number) => {
  const storageLimit = storageLimitToBytes(organization.storageLimit ?? DEFAULT_STORAGE_LIMIT_MB);
  if (fileSize > storageLimit) throw new BadRequestError('Organization storage limit exceeded');
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
