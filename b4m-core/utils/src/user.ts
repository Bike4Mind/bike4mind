import { IUserDocument, IOrganizationDocument } from '@bike4mind/common';
import { BadRequestError } from './errors';

export const checkStorageLimit = async (user: IUserDocument, fileSize: number) => {
  const storageLimit = (user.storageLimit ?? 1000) * 1000000; // Convert to Bytes
  const currentStorageSize = user.currentStorageSize ?? 0;
  if (fileSize + currentStorageSize > storageLimit) throw new BadRequestError('File size exceeds storage limit');
};

export const checkOrganizationStorageLimit = async (organization: IOrganizationDocument, fileSize: number) => {
  const storageLimit = (organization.storageLimit ?? 1000) * 1000000; // Convert to Bytes
  const currentStorageSize = organization.currentStorageSize ?? 0;
  if (fileSize + currentStorageSize > storageLimit) throw new BadRequestError('Organization storage limit exceeded');
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
