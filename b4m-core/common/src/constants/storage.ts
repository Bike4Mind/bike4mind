// A user's or organization's `storageLimit` is stored in decimal MB, not MiB. Enforcement
// (checkStorageLimit in @bike4mind/utils), the user-facing quota UI and the admin Users screens
// all convert through storageLimitToBytes so they agree on the same byte figure.
export const BYTES_PER_STORAGE_MB = 1_000_000;

/** The limit applied when `storageLimit` is unset. */
export const DEFAULT_STORAGE_LIMIT_MB = 1000;

export const storageLimitToBytes = (storageLimitMb: number): number => storageLimitMb * BYTES_PER_STORAGE_MB;
