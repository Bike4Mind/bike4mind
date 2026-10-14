import { storageLimitToBytes } from '@bike4mind/common';

/**
 * Computes storage usage as a percentage of the decimal-MB limit (can exceed 100).
 *
 * A limit of 0 or below reads as 100: checkStorageLimit refuses every non-empty upload there,
 * so the account is full whatever it holds. Shared by the admin list and detail views so they agree.
 */
export function computeStoragePercent(currentStorageSize: number, storageLimitMb: number): number {
  const storageLimitBytes = storageLimitToBytes(storageLimitMb);
  if (storageLimitBytes <= 0) return 100;
  return (currentStorageSize / storageLimitBytes) * 100;
}
