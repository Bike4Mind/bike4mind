/**
 * Computes storage usage as a percentage (0-100).
 *
 * Returns 0 when storageLimit is 0 to avoid a NaN result from dividing
 * by zero (which would happen for users created with no storage allocation).
 */
export function computeStoragePercent(currentStorageSize: number, storageLimitMb: number): number {
  const storageLimitBytes = storageLimitMb * 1024 * 1024;
  if (storageLimitBytes <= 0) return 0;
  return (currentStorageSize / storageLimitBytes) * 100;
}
