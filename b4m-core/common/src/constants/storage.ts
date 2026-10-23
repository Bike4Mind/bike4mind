// A user's or organization's `storageLimit` is stored in decimal MB, not MiB. Enforcement
// (checkStorageLimit in @bike4mind/utils), the user-facing quota UI and the admin Users screens
// all convert through storageLimitToBytes so they agree on the same byte figure.
export const BYTES_PER_STORAGE_MB = 1_000_000;

/** The limit applied when a user's `storageLimit` is unset. */
export const DEFAULT_STORAGE_LIMIT_MB = 1000;

/**
 * The limit applied when an organization's `storageLimit` is unset: one pool shared by every file the
 * org owns, so larger than a single user's default.
 */
export const DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB = 10_000;

/** Upper bound for an admin-set limit (1 PB): keeps the byte figure finite and inside Number.MAX_SAFE_INTEGER. */
export const MAX_STORAGE_LIMIT_MB = 1_000_000_000;

export const storageLimitToBytes = (storageLimitMb: number): number => storageLimitMb * BYTES_PER_STORAGE_MB;

/** An organization's effective quota in bytes: its own `storageLimit`, else DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB. */
export const organizationStorageLimitBytes = (organization: { storageLimit?: number | null }): number =>
  storageLimitToBytes(organization.storageLimit ?? DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB);
