/**
 * One uploader's share of an organization's charged storage, as
 * FabFileRepository.summarizeChargedStorageByOrganizationId returns it: the org-owned rows
 * (FabFile.organizationId, see storageOwner.ts) grouped by the `userId` that uploaded them.
 */
export interface OrganizationStorageUploaderGroup {
  userId: string;
  bytes: number;
  fileCount: number;
}

export interface OrganizationStorageUploader extends OrganizationStorageUploaderGroup {
  /** Null when the uploader's account no longer exists. */
  name: string | null;
  email: string | null;
}

/** GET /api/organizations/:id/storage-usage. */
export interface OrganizationStorageUsage {
  organizationId: string;
  /** The org counter (Organization.currentStorageSize) that quota checks enforce against. */
  usedBytes: number;
  /** organizationStorageLimitBytes: the org's own limit, else the default. */
  limitBytes: number;
  /** Largest first. Sums to the rows' truth, which can differ from `usedBytes` while the counter drifts. */
  uploaders: OrganizationStorageUploader[];
  /** True when more uploaders hold storage than `uploaders` lists. */
  uploadersTruncated: boolean;
}
