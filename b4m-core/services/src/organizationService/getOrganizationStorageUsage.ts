import {
  IFabFileRepository,
  IOrganizationDocument,
  IUserRepository,
  OrganizationStorageUsage,
  organizationStorageLimitBytes,
} from '@bike4mind/common';

/** How many uploaders the breakdown lists; an org with more reports `uploadersTruncated`. */
export const ORGANIZATION_STORAGE_UPLOADER_LIMIT = 50;

export interface GetOrganizationStorageUsageAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'summarizeChargedStorageByOrganizationId'>;
    users: Pick<IUserRepository, 'findByIds'>;
  };
}

/**
 * What an organization's storage pool holds and who uploaded it. No authorization here: the caller
 * has already resolved `organization` through an org-admin read gate (verifyOrgAdminRead).
 */
export const getOrganizationStorageUsage = async (
  organization: Pick<IOrganizationDocument, 'id' | 'storageLimit' | 'currentStorageSize'>,
  { db }: GetOrganizationStorageUsageAdapters,
  options: { maxTimeMS?: number } = {}
): Promise<OrganizationStorageUsage> => {
  // One extra group answers "are there more" without a second count query.
  const groups = await db.fabFiles.summarizeChargedStorageByOrganizationId(organization.id, {
    limit: ORGANIZATION_STORAGE_UPLOADER_LIMIT + 1,
    maxTimeMS: options.maxTimeMS,
  });
  const listed = groups.slice(0, ORGANIZATION_STORAGE_UPLOADER_LIMIT);

  const users = listed.length > 0 ? await db.users.findByIds(listed.map(group => group.userId)) : [];
  const userById = new Map(users.map(user => [String(user.id), user]));

  return {
    organizationId: organization.id,
    usedBytes: Math.max(0, organization.currentStorageSize ?? 0),
    limitBytes: Math.max(0, organizationStorageLimitBytes(organization)),
    uploaders: listed.map(group => {
      const user = userById.get(group.userId);
      return { ...group, name: user?.name || user?.username || null, email: user?.email ?? null };
    }),
    uploadersTruncated: groups.length > ORGANIZATION_STORAGE_UPLOADER_LIMIT,
  };
};
