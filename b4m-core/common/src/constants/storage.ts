// A user's or organization's `storageLimit` is stored in decimal MB, not MiB. Enforcement
// (checkStorageLimit in @bike4mind/utils), the user-facing quota UI and the admin Users screens
// all convert through storageLimitToBytes so they agree on the same byte figure.
export const BYTES_PER_STORAGE_MB = 1_000_000;

/** The limit applied when a user's `storageLimit` is unset. */
export const DEFAULT_STORAGE_LIMIT_MB = 1000;

/**
 * The limit applied when an organization has neither an override nor a plan allowance: one pool shared
 * by every file the org owns, so larger than a single user's default.
 */
export const DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB = 10_000;

/** Upper bound for an admin-set limit (1 PB): keeps the byte figure finite and inside Number.MAX_SAFE_INTEGER. */
export const MAX_STORAGE_LIMIT_MB = 1_000_000_000;

export const storageLimitToBytes = (storageLimitMb: number): number => storageLimitMb * BYTES_PER_STORAGE_MB;

export const resolveOrganizationStorageLimit = (allocation: UserStorageAllocation) => {
  // Unlike users, orgs never had a schema default: every existing non-null limit was manually set.
  const legacyOverride =
    allocation.storageLimitOverride === undefined && allocation.planStorageLimit === undefined
      ? allocation.storageLimit
      : null;
  const override = allocation.storageLimitOverride ?? legacyOverride;
  if (override != null) return { limitMb: override, source: 'override' as const };
  if (allocation.planStorageLimit != null) return { limitMb: allocation.planStorageLimit, source: 'plan' as const };
  return { limitMb: DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB, source: 'default' as const };
};

export const organizationStorageLimitBytes = (organization: UserStorageAllocation): number =>
  storageLimitToBytes(resolveOrganizationStorageLimit(organization).limitMb);

export type UserStorageAllocation = {
  storageLimit?: number | null;
  storageLimitOverride?: number | null;
  planStorageLimit?: number | null;
};

/** Explicit null retires the legacy fallback, allowing an override to be cleared. */
export const resolveUserStorageLimit = (allocation: UserStorageAllocation) => {
  const legacyOverride =
    allocation.storageLimitOverride === undefined &&
    allocation.planStorageLimit === undefined &&
    allocation.storageLimit !== DEFAULT_STORAGE_LIMIT_MB
      ? allocation.storageLimit
      : null;
  const override = allocation.storageLimitOverride ?? legacyOverride;
  if (override != null) return { limitMb: override, source: 'override' as const };
  if (allocation.planStorageLimit != null) return { limitMb: allocation.planStorageLimit, source: 'plan' as const };
  return { limitMb: DEFAULT_STORAGE_LIMIT_MB, source: 'default' as const };
};
